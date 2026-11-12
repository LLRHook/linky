"""Opt-in Jira worklogs for dev-cycle runs (stdlib only). Run through `python .cycle/trackers.py worklog ...`.

Rules (.cycle/TRACKERS.md, "Worklogs"): nothing is tracked or posted unless the person whose
time it is chose it, for this run (`start --consent run`) or for themselves in this clone
(`mode auto`, stored in the clone's git config and tied to their Jira account). The repo can
only turn the feature off (`jira.worklog: "off"`), never on for anyone. A worklog over 8 hours
is never posted without `--confirm-long`, which a command passes only after the person confirms.
Runs that overlap in time (two repos, two worktrees) split each shared active minute evenly, so
your total never exceeds real time; an overlap with your other Jira worklogs is never posted
without `--confirm-overlap`.

  worklog state                          off | never | ask | auto (+ preview)
  worklog mode auto|ask|never [--preview on|off] [--idle MIN]
  worklog start LABEL --consent run|auto [--command C]
  worklog pause LABEL | resume LABEL     stop / restart the clock (waiting on the person)
  worklog retarget OLD NEW               a placeholder label (`run`) gets its ticket or bundle
  worklog finish LABEL [--yes] [--minutes N] [--comment-file F|-] [--confirm-long] [--confirm-overlap] [--force]
  worklog drop LABEL                     discard an open session, post nothing
  worklog undo LABEL|KEY                 delete the last worklog this clone posted there
  worklog status                         open and posted sessions in this clone
  worklog hook                           Claude Code hook (stdin event): tool calls and sub-agents as busy time

LABEL is a tracker id (its `Jira:` key is used), a Jira key (a bundle Task), or `run`.
Exit codes: 0 done or preview printed; 3 needs the person's confirmation (over 8 hours, or
overlapping their other Jira worklogs).
"""
import datetime, json, os, secrets, sys, time

import tracker_ops as T

STATE = 'cycle-worklog.json'
EVENTS = 'cycle-worklog.events'   # append-only activity log: safe under parallel hooks
HOOK_EVENTS = ('PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop',
               'Stop', 'UserPromptSubmit', 'SessionEnd')
LOCAL_SETTINGS = os.path.join('.claude', 'settings.local.json')
IDLE_MIN = 30
LONG_S = 8 * 3600          # fixed: a longer worklog always needs the person's confirmation
NEEDS_CONFIRM = 3
KEEP_POSTED_S = 14 * 86400  # posted runs stay in the personal registry this long for overlap splits
CFG = 'cycle.worklog.'


# ------------------------------------------------------------------ local state

def state_path(root=None, name=STATE):
    """One file per clone, shared by its worktrees, never committed (.git/cycle-worklog.*)."""
    common = T.git('rev-parse', '--git-common-dir', cwd=root)
    if not common:
        return None
    return os.path.join(os.path.abspath(os.path.join(root or os.getcwd(), common)), name)


def load(root):
    p = state_path(root)
    if p and os.path.exists(p):
        with open(p, encoding='utf-8') as f:
            return json.load(f)
    return {'open': {}, 'posted': []}


def save(root, st):
    with open(state_path(root), 'w', encoding='utf-8') as f:
        json.dump(st, f, indent=1)


def record(root, kind, key='-'):
    """Append one activity line `<epoch> <M|B|E|C> <key>` while a session is open. Never raises.
    M = mark, B/E = busy span begin/end (tool:<id>, agent:<id>), C = close open spans (tool|all)."""
    try:
        sp = state_path(root)
        if not (sp and os.path.exists(sp)):
            return
        with open(state_path(root, EVENTS), 'a', encoding='utf-8') as f:
            f.write('%d %s %s\n' % (int(time.time()), kind, key))
    except Exception:
        pass


def beat(root):
    """Activity mark; called on any trackers.py command."""
    record(root, 'M')


def read_events(root):
    p = state_path(root, EVENTS)
    out = []
    if p and os.path.exists(p):
        with open(p, encoding='utf-8', errors='replace') as f:
            for line in f:
                parts = line.split()
                if len(parts) == 3 and parts[0].isdigit():
                    out.append((int(parts[0]), parts[1], parts[2]))
    return out


def prune_events(root, st):
    """Keep only lines a still-open session can use; drop the log when none is open."""
    p = state_path(root, EVENTS)
    if not (p and os.path.exists(p)):
        return
    starts = [s['intervals'][0][0] for s in st['open'].values()]
    if not starts:
        os.remove(p)
        return
    keep = [e for e in read_events(root) if e[0] >= min(starts)]
    with open(p, 'w', encoding='utf-8') as f:
        f.writelines('%d %s %s\n' % e for e in keep)


def spans(events, now):
    """Busy spans [(begin, end)] from B/E/C lines. A tool span left open (interrupted call) ends at the
    next Stop or prompt (C tool); a sub-agent span at its SubagentStop or the session end (C all)."""
    open_, out = {}, []
    for t, kind, key in sorted(events):
        if kind == 'B':
            open_.setdefault(key, t)
        elif kind == 'E' and key in open_:
            out.append((open_.pop(key), t))
        elif kind == 'C':
            for k in [k for k in open_ if key == 'all' or k.startswith(key + ':')]:
                out.append((open_.pop(k), t))
    out += [(b, now) for b in open_.values()]
    return out


# ------------------------------------------------------------------ Claude Code hooks

def cmd_hook(root, o, pos):
    """Claude Code hook: a tool call or sub-agent counts as busy for as long as it runs. Always exit 0."""
    try:
        ev = json.load(sys.stdin)
    except ValueError:
        return 0
    name = ev.get('hook_event_name', '')
    tid = 'tool:%s' % (ev.get('tool_use_id') or '-')
    aid = 'agent:%s' % (ev.get('agent_id') or '-')
    if name == 'PreToolUse':
        record(root, 'B', tid)
    elif name in ('PostToolUse', 'PostToolUseFailure'):
        record(root, 'E', tid)
    elif name == 'SubagentStart':
        record(root, 'B', aid)
    elif name == 'SubagentStop':
        record(root, 'E', aid)
    elif name in ('Stop', 'UserPromptSubmit'):
        record(root, 'C', 'tool')
    elif name == 'SessionEnd':
        record(root, 'C', 'all')
    return 0


def _hook_command():
    return T.PY_SH + ' "$CLAUDE_PROJECT_DIR/.cycle/trackers.py" worklog hook' if hasattr(T, 'PY_SH') else \
        '"$(command -v python3 || command -v python)" "$CLAUDE_PROJECT_DIR/.cycle/trackers.py" worklog hook'


def set_hooks(root, on):
    """Add (or remove) the activity hooks in this person's .claude/settings.local.json, which is
    personal and kept out of git (.git/info/exclude). Only people who opted in get them."""
    p = os.path.join(root, LOCAL_SETTINGS)
    try:
        cfg = json.load(open(p, encoding='utf-8')) if os.path.exists(p) else {}
    except ValueError:
        print('worklog: %s is not valid JSON; activity hooks not changed' % LOCAL_SETTINGS)
        return
    hooks = cfg.setdefault('hooks', {})
    probe = 'trackers.py" worklog hook'
    changed = False
    for event in HOOK_EVENTS:
        lst = hooks.get(event, [])
        mine = [h for h in lst if any(probe in c.get('command', '') for c in h.get('hooks', []))]
        if on and not mine:
            hooks.setdefault(event, []).append(
                {'hooks': [{'type': 'command', 'command': _hook_command(), 'timeout': 10}]})
            changed = True
        elif not on and mine:
            hooks[event] = [h for h in lst if h not in mine]
            if not hooks[event]:
                del hooks[event]
            changed = True
    if not changed:
        return
    if not hooks:
        cfg.pop('hooks')
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(cfg, f, indent=2)
        f.write('\n')
    if on:
        _exclude(root, '/' + LOCAL_SETTINGS.replace(os.sep, '/'))
    print('worklog: activity hooks %s %s' % ('added to' if on else 'removed from', LOCAL_SETTINGS))


def _exclude(root, pattern):
    common = T.git('rev-parse', '--git-common-dir', cwd=root)
    if not common:
        return
    ex = os.path.join(os.path.abspath(os.path.join(root, common)), 'info', 'exclude')
    have = open(ex, encoding='utf-8').read().split('\n') if os.path.exists(ex) else []
    if pattern not in have:
        os.makedirs(os.path.dirname(ex), exist_ok=True)
        with open(ex, 'a', encoding='utf-8') as f:
            f.write(('' if not have or have[-1] == '' else '\n') + pattern + '\n')


# ------------------------------------------------------------- personal setting

def personal(root):
    def g(k, d):
        return T.git('config', '--local', CFG + k, cwd=root) or d
    try:
        idle = int(g('idle', str(IDLE_MIN)))
    except ValueError:
        idle = IDLE_MIN
    return {'mode': g('mode', 'ask'), 'preview': g('preview', 'on'), 'idle': idle, 'account': g('account', '')}


def me_of(jira):
    ref, name = jira.myself()
    return (ref.get('accountId') or ref.get('name')), name


def jira_for(root):
    """(Jira, None) when worklogs can run here, else (None, reason)."""
    if T.jira_mode(root) == 'off':
        return None, 'Jira is off for this repo'
    if (T.load_config(root).get('jira') or {}).get('worklog') == 'off':
        return None, 'worklogs are off for this repo (jira.worklog)'
    j = T.Jira(T.load_config(root))
    if j.missing():
        return None, '%s not set' % ', '.join(j.missing())
    return j, None


def effective(root):
    """(state, detail): off | never | ask | auto. auto only while the saved account is the token's."""
    jira, why = jira_for(root)
    if not jira:
        return 'off', why
    p = personal(root)
    if p['mode'] == 'never':
        return 'never', 'you chose never in this clone'
    if p['mode'] != 'auto':
        return 'ask', 'no saved choice in this clone'
    try:
        acct, _ = me_of(jira)
    except T.NET_ERRORS as ex:
        return 'ask', 'Jira user not read (%s)' % ex
    if acct != p['account']:
        return 'ask', 'the saved auto belongs to another Jira account'
    return 'auto', 'preview %s, idle cap %d min' % (p['preview'], p['idle'])


def cmd_state(root, o, pos):
    st, detail = effective(root)
    print('%s  (%s)' % (st, detail))
    return 0


def cmd_mode(root, o, pos):
    if not pos or pos[0] not in ('auto', 'ask', 'never'):
        sys.exit('usage: worklog mode auto|ask|never [--preview on|off] [--idle MIN]')
    mode = pos[0]
    if mode == 'auto':
        jira, why = jira_for(root)
        if not jira:
            sys.exit('worklog mode auto: %s' % why)
        try:
            acct, name = me_of(jira)
        except T.NET_ERRORS as ex:
            sys.exit('worklog mode auto: Jira user not read: %s' % ex)
        T.git('config', '--local', CFG + 'account', acct, cwd=root)
        print('auto for %s, in this clone only' % name)
    T.git('config', '--local', CFG + 'mode', mode, cwd=root)
    if mode == 'never':
        set_hooks(root, False)
    elif mode == 'auto':
        set_hooks(root, True)
    if o.get('preview') in ('on', 'off'):
        T.git('config', '--local', CFG + 'preview', o['preview'], cwd=root)
    if o.get('idle'):
        T.git('config', '--local', CFG + 'idle', str(int(o['idle'])), cwd=root)
    p = personal(root)
    print('worklog mode %s (preview %s, idle cap %d min): stored in .git/config, never committed' % (
        p['mode'], p['preview'], p['idle']))
    return 0


# --------------------------------------------- personal registry (all repos on this machine)

def registry_path():
    """Per person, outside every repo: lists this person's open and recently posted runs, so runs
    in different repos or worktrees can split the minutes they share."""
    return os.environ.get('CYCLE_WORKLOG_REGISTRY') or os.path.join(
        os.path.expanduser('~'), '.claude', 'cycle-worklog-registry.json')


def reg_load():
    try:
        with open(registry_path(), encoding='utf-8') as f:
            r = json.load(f)
    except (OSError, ValueError):
        r = {}
    r.setdefault('open', {})
    r.setdefault('posted', [])
    return r


def reg_save(r):
    p = registry_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + '.%d.tmp' % os.getpid()
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(r, f, indent=1)
    os.replace(tmp, p)  # atomic: a reader never sees half a file


def reg_open(sid, root):
    r = reg_load()
    r['open'][sid] = {'root': os.path.abspath(root)}
    reg_save(r)


def reg_close(sid, posted=None):
    r = reg_load()
    r['open'].pop(sid, None)
    cutoff = int(time.time()) - KEEP_POSTED_S
    r['posted'] = [x for x in r['posted'] if x.get('at', 0) >= cutoff and x.get('sid') != sid]
    if posted:
        r['posted'].append(posted)
    reg_save(r)


def other_runs(sid, now):
    """[(name, active segments)] for this person's other runs: open ones measured live from their
    repo, posted ones from the segments they recorded. Stale open entries are dropped."""
    r = reg_load()
    out, stale = [], []
    for osid, x in r['open'].items():
        if osid == sid:
            continue
        found = _find_session(x['root'], osid)
        if not found:
            stale.append(osid)
            continue
        label, sess = found
        segs, _, _ = segments(x['root'], sess, now)
        out.append(('%s in %s' % (label, os.path.basename(x['root'])), segs))
    for x in r['posted']:
        if x.get('sid') != sid:
            out.append(('%s (posted)' % x.get('key', '?'), [tuple(g) for g in x.get('segs', [])]))
    if stale:
        for osid in stale:
            r['open'].pop(osid, None)
        reg_save(r)
    return out


def _find_session(root, sid):
    if not os.path.isdir(root):
        return None
    try:
        st = load(root)
    except (OSError, ValueError):
        return None
    for label, s in st.get('open', {}).items():
        if s.get('id') == sid:
            return label, s
    return None


def share(own, others):
    """(seconds, shared_by): own active time with every minute shared with N other runs counted
    1/(N+1) — an even split, the same whichever run finishes first. O(b * r), b boundaries, r runs."""
    pts = sorted({p for seg in own for p in seg} | {p for _, segs in others for seg in segs for p in seg})
    total, by = 0.0, {}
    for x, y in zip(pts, pts[1:]):
        if not _covers(own, x, y):
            continue
        with_ = [name for name, segs in others if _covers(segs, x, y)]
        total += (y - x) / (len(with_) + 1.0)
        for name in with_:
            by[name] = by.get(name, 0) + (y - x)
    return total, by


def _covers(segs, x, y):
    return any(a <= x and y <= b for a, b in segs)


# ---------------------------------------------------------------------- sessions

def _open(st, label):
    s = st['open'].get(label)
    if not s:
        sys.exit('worklog: no open session %s (worklog status)' % (label or '?'))
    return s


def cmd_start(root, o, pos):
    if not pos:
        sys.exit('usage: worklog start LABEL --consent run|auto')
    label, consent = pos[0], o.get('consent')
    if consent not in ('run', 'auto'):
        sys.exit('worklog start: --consent run (the person said yes for this run) or auto is required')
    state, detail = effective(root)
    if state == 'off':
        sys.exit('worklog start: %s' % detail)
    if state == 'never':
        sys.exit('worklog start: the person chose never in this clone')
    if consent == 'auto' and state != 'auto':
        sys.exit('worklog start: --consent auto, but this clone is %s (%s): ask the person' % (state, detail))
    st = load(root)
    if label in st['open']:
        return cmd_resume(root, o, pos)
    now = int(time.time())
    st['open'][label] = {'id': secrets.token_hex(4), 'consent': consent, 'command': o.get('command', ''),
                         'head': T.git('rev-parse', 'HEAD', cwd=root) or '', 'intervals': [[now, None]],
                         'marks': [now]}
    save(root, st)
    reg_open(st['open'][label]['id'], root)
    set_hooks(root, True)
    print('worklog: tracking %s (%s consent)' % (label, consent))
    return 0


def cmd_pause(root, o, pos):
    st = load(root)
    s = _open(st, pos[0] if pos else '')
    if s['intervals'][-1][1] is None:
        s['intervals'][-1][1] = int(time.time())
        save(root, st)
    print('worklog: %s paused' % pos[0])
    return 0


def cmd_resume(root, o, pos):
    st = load(root)
    s = _open(st, pos[0] if pos else '')
    if s['intervals'][-1][1] is not None:
        now = int(time.time())
        s['intervals'].append([now, None])
        s['marks'].append(now)
        save(root, st)
    print('worklog: %s resumed' % pos[0])
    return 0


def cmd_retarget(root, o, pos):
    if len(pos) != 2:
        sys.exit('usage: worklog retarget OLD NEW')
    st = load(root)
    _open(st, pos[0])
    if pos[1] in st['open']:
        sys.exit('worklog: %s already has an open session' % pos[1])
    st['open'][pos[1]] = st['open'].pop(pos[0])
    save(root, st)
    print('worklog: %s -> %s' % (pos[0], pos[1]))
    return 0


def cmd_drop(root, o, pos):
    st = load(root)
    sid = _open(st, pos[0] if pos else '')['id']
    st['open'].pop(pos[0])
    save(root, st)
    prune_events(root, st)
    reg_close(sid)
    print('worklog: %s dropped, nothing posted' % pos[0])
    return 0


# ---------------------------------------------------------------------- measuring

def _changed_mtimes(root, head):
    files = set()
    for args in (('diff', '--name-only', head) if head else ('diff', '--name-only'),
                 ('ls-files', '--others', '--exclude-standard')):
        files.update(l for l in (T.git(*args, cwd=root) or '').splitlines() if l)
    out = []
    for f in files:
        try:
            out.append(int(os.path.getmtime(os.path.join(root, f))))
        except OSError:
            pass
    return out


def _commits(root, head):
    if not head:
        return []
    out = T.git('log', '--format=%ct\t%s', '%s..HEAD' % head, cwd=root) or ''
    return [(int(t), subj) for t, subj in (l.split('\t', 1) for l in out.splitlines() if '\t' in l)]


def measure(s, marks, idle_s, now, busy=()):
    """(active, elapsed, dropped) seconds; see active_segments."""
    segs, elapsed, dropped = active_segments(s, marks, idle_s, now, busy)
    return sum(y - x for x, y in segs), elapsed, dropped


def active_segments(s, marks, idle_s, now, busy=()):
    """(merged active segments, elapsed, dropped) within the session's intervals (pauses excluded).
    Active = the union of (a) gaps between activity marks no longer than the idle cap and (b) busy
    spans (a tool call or sub-agent running: builds, test runs, agents), which count in full however
    long they run. dropped = idle gaps not covered by a busy span. O(n log n) in marks and spans."""
    out, elapsed, dropped = [], 0, 0
    for a, b in s['intervals']:
        b = now if b is None else b
        elapsed += b - a
        segs = [(max(x, a), min(y, b)) for x, y in busy if y > a and x < b]
        busy_here = list(segs)
        pts = sorted({a, b} | {m for m in marks if a < m < b} | {p for seg in segs for p in seg})
        for x, y in zip(pts, pts[1:]):
            if y - x <= idle_s:
                segs.append((x, y))
            elif not any(bx <= x and y <= by for bx, by in busy_here):
                dropped += 1
        out += _merge(segs)
    return _merge(out), elapsed, dropped


def _merge(segs):
    out = []
    for x, y in sorted(segs):
        if out and x <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], y))
        elif y > x:
            out.append((x, y))
    return out


def segments(root, s, now):
    """A session's active segments from everything its repo recorded."""
    ev = read_events(root)
    marks = s['marks'] + [t for t, _, _ in ev] + [t for t, _ in _commits(root, s['head'])] + \
        _changed_mtimes(root, s['head'])
    return active_segments(s, marks, personal(root)['idle'] * 60, now, spans(ev, now))


def _hm(sec):
    m = max(1, int(round(sec / 60.0)))
    return '%dh %02dm' % divmod(m, 60) if m >= 60 else '%dm' % m


def _target(root, label):
    if label == 'run':
        sys.exit('worklog finish: `run` was never retargeted to a ticket or bundle (worklog retarget run <ID>)')
    if T.KEY_RE.match(label) and not label.startswith(('BUG-', 'FEAT-')):
        return label, None
    _, e = T.locate(root, label)
    key = e.value('Jira') or ''
    if not T.KEY_RE.match(key):
        sys.exit('worklog finish: %s has no Jira key (jira sync first)' % label)
    return key, e


def _summary(o, e):
    if o.get('comment-file') == '-':
        return sys.stdin.read().strip()
    if o.get('comment-file'):
        return T.read(o['comment-file']).strip()
    return ((e.value('Fix') or e.value('Implementation')) if e else '') or ''


def build(root, label, s, o, now):
    key, e = _target(root, label)
    commits = _commits(root, s['head'])
    segs, elapsed, dropped = segments(root, s, now)
    active = sum(y - x for x, y in segs)
    mine, shared = share(segs, other_runs(s['id'], now))
    seconds = int(o['minutes']) * 60 if o.get('minutes') else max(60, int(round(mine / 60.0)) * 60)
    summary = _summary(o, e)
    lines = ([summary] if summary else []) + (['Commits:'] + ['- %s' % subj for _, subj in commits[:15]] if commits else [])
    lines.append('[cycle-worklog %s %s]' % (label, s['id']))
    first = min(a for a, _ in s['intervals'])
    started = datetime.datetime.fromtimestamp(first).astimezone().strftime('%Y-%m-%dT%H:%M:%S.000%z')
    return {'key': key, 'seconds': seconds, 'started': started, 'comment': '\n'.join(lines),
            'active': active, 'elapsed': elapsed, 'dropped': dropped, 'commits': len(commits),
            'edited': bool(o.get('minutes')), 'segs': segs, 'shared': shared}


def _jira_time(text):
    try:
        return int(datetime.datetime.strptime(text, '%Y-%m-%dT%H:%M:%S.%f%z').timestamp())
    except (TypeError, ValueError):
        return None


def jira_overlaps(jira, segs, ours):
    """This person's other Jira worklogs (any issue, any machine, entered by hand or not) whose
    block overlaps these active segments. Worklogs this machine's runs posted (markers in OURS) are
    already split precisely and skipped. [(key, id, overlap seconds)]."""
    if not segs:
        return []
    ref, _ = jira.myself()
    day = datetime.datetime.fromtimestamp(segs[0][0] - 86400).strftime('%Y-%m-%d')
    res = jira.search('worklogAuthor = currentUser() AND worklogDate >= "%s"' % day, ['summary'], 50)
    out = []
    for issue in res.get('issues', []):
        logs = jira.req('GET', '/rest/api/2/issue/%s/worklog?maxResults=1000' % issue['key']).get('worklogs', [])
        for x in logs:
            a = x.get('author') or {}
            if not all(a.get(k) == v for k, v in ref.items()):
                continue
            if any(m in str(x.get('comment') or '') for m in ours):
                continue
            b0 = _jira_time(x.get('started'))
            if b0 is None:
                continue
            blk = [(b0, b0 + int(x.get('timeSpentSeconds') or 0))]
            ov = sum(min(y, blk[0][1]) - max(sx, blk[0][0]) for sx, y in segs if y > blk[0][0] and sx < blk[0][1])
            if ov > 0:
                out.append((issue['key'], x.get('id'), ov))
    return out


def post(jira, w, marker):
    """Post once: a worklog already carrying this session's marker is not posted again. (id, new)."""
    logs = jira.req('GET', '/rest/api/2/issue/%s/worklog?maxResults=1000' % w['key']).get('worklogs', [])
    hit = next((x for x in logs if marker in str(x.get('comment') or '')), None)
    if hit:
        print('worklog %s: already posted (#%s); not posted again' % (w['key'], hit['id']))
        return hit['id'], False
    r = jira.req('POST', '/rest/api/2/issue/%s/worklog' % w['key'], {
        'started': w['started'], 'timeSpentSeconds': w['seconds'], 'comment': w['comment']})
    return r.get('id'), True


def cmd_finish(root, o, pos):
    if not pos:
        sys.exit('usage: worklog finish LABEL [--yes] [--minutes N] [--comment-file F|-] [--confirm-long]')
    label = pos[0]
    st = load(root)
    s = _open(st, label)
    now = int(time.time())
    w = build(root, label, s, o, now)
    if not w['commits'] and not o.get('force'):
        sys.exit('worklog finish: nothing committed since %s started; not logged (commit first)' % label)
    print('worklog %s: %s from %s (active %s of %s elapsed; %d idle gap(s) over %d min dropped%s)' % (
        w['key'], _hm(w['seconds']), w['started'], _hm(w['active']), _hm(w['elapsed']), w['dropped'],
        personal(root)['idle'], '; duration edited' if w['edited'] else ''))
    for name, sec in sorted(w['shared'].items()):
        print('  shared %s with %s: split evenly' % (_hm(sec), name))
    print('  ' + w['comment'].replace('\n', '\n  '))
    jira, why = jira_for(root)
    overlaps, checked = [], False
    if jira:
        ours = [' %s]' % x.get('sid') for x in reg_load()['posted']] + [' %s]' % s['id']]  # marker tails
        try:
            overlaps, checked = jira_overlaps(jira, w['segs'], ours), True
        except T.NET_ERRORS as ex:
            print('  overlap with your other Jira worklogs NOT CHECKED: %s' % ex)
    for key, wid, sec in overlaps:
        print('OVERLAPS your worklog %s #%s by %s. Always ask the person; post only with `--confirm-overlap` '
              'after they confirm (or edit with --minutes N).' % (key, wid, _hm(sec)))
    long_ = w['seconds'] > LONG_S
    if long_:
        print('OVER 8 HOURS: %s. Always ask the person to confirm or edit the duration; post only with '
              '`--confirm-long` after they confirm.' % _hm(w['seconds']))
    if not o.get('yes'):
        print('preview only: post with `worklog finish %s --yes [--minutes N]`' % label)
        return NEEDS_CONFIRM if long_ or overlaps else 0
    if long_ and not o.get('confirm-long'):
        print('not posted: over 8 hours needs the person\'s confirmation (--confirm-long)')
        return NEEDS_CONFIRM
    if not jira:
        sys.exit('worklog finish: %s; session kept' % why)
    if not checked:
        sys.exit('worklog finish: not posted: overlap with your other worklogs could not be checked; session kept')
    if overlaps and not o.get('confirm-overlap'):
        print('not posted: overlaps your other Jira worklogs; needs the person\'s confirmation (--confirm-overlap)')
        return NEEDS_CONFIRM
    try:
        wid, new = post(jira, w, '[cycle-worklog %s %s]' % (label, s['id']))
    except T.NET_ERRORS as ex:
        sys.exit('worklog finish: not posted: %s; session kept, retry later' % ex)
    if new:
        print('worklog %s: posted %s (#%s); undo: worklog undo %s' % (w['key'], _hm(w['seconds']), wid, label))
    st['open'].pop(label)
    st['posted'] = (st.get('posted') or [])[-49:] + [
        {'label': label, 'key': w['key'], 'id': wid, 'seconds': w['seconds'], 'at': now, 'sid': s['id']}]
    save(root, st)
    prune_events(root, st)
    reg_close(s['id'], {'sid': s['id'], 'key': w['key'], 'at': now, 'segs': [list(g) for g in w['segs']]})
    return 0


def cmd_undo(root, o, pos):
    if not pos:
        sys.exit('usage: worklog undo LABEL|KEY')
    st = load(root)
    hit = next((p for p in reversed(st.get('posted') or []) if pos[0] in (p['label'], p['key'])), None)
    if not hit:
        sys.exit('worklog undo: nothing this clone posted for %s' % pos[0])
    jira, why = jira_for(root)
    if not jira:
        sys.exit('worklog undo: %s' % why)
    try:
        jira.req('DELETE', '/rest/api/2/issue/%s/worklog/%s' % (hit['key'], hit['id']))
    except T.NET_ERRORS as ex:
        sys.exit('worklog undo: %s' % ex)
    st['posted'].remove(hit)
    save(root, st)
    if hit.get('sid'):
        reg_close(hit['sid'])
    print('worklog %s: #%s deleted' % (hit['key'], hit['id']))
    return 0


def cmd_status(root, o, pos):
    state, detail = effective(root)
    print('mode   %s (%s)' % (state, detail))
    st = load(root)
    now, idle = int(time.time()), personal(root)['idle'] * 60
    ev = read_events(root)
    for label, s in st['open'].items():
        a, e, _ = measure(s, s['marks'] + [t for t, _, _ in ev], idle, now, spans(ev, now))
        print('open   %-14s %s consent, active %s of %s%s' % (
            label, s['consent'], _hm(a), _hm(e), '' if s['intervals'][-1][1] is None else ' (paused)'))
    for p in (st.get('posted') or [])[-5:]:
        print('posted %-14s %s #%s %s' % (p['label'], p['key'], p['id'], _hm(p['seconds'])))
    return 0


SUBS = {'hook': cmd_hook, 'state': cmd_state, 'mode': cmd_mode, 'start': cmd_start, 'pause': cmd_pause, 'resume': cmd_resume,
        'retarget': cmd_retarget, 'drop': cmd_drop, 'finish': cmd_finish, 'undo': cmd_undo, 'status': cmd_status}


def main(argv):
    if not argv or argv[0] not in SUBS:
        sys.exit(__doc__)
    if argv[0] == 'hook':
        try:
            return cmd_hook(os.environ.get('CLAUDE_PROJECT_DIR') or T.repo_root(), {}, [])
        except Exception:
            return 0
    o, pos = T.opts(argv[1:], flags=('yes', 'force', 'confirm-long', 'confirm-overlap'))
    return SUBS[argv[0]](T.repo_root(), o, pos)
