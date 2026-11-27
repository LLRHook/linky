"""Tracker writers, schema and Jira sync for the dev-cycle trackers (stdlib only).

Imported by trackers.py; run everything through `python .cycle/trackers.py <cmd>`.
Format reference: .cycle/TRACKERS.md (source: trackers/references/tracker-format.md).
"""
import base64, datetime, fnmatch, http.client, json, os, re, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

HEAD_RE = re.compile(r'^### \[((?:BUG|FEAT)-\d+[a-z]*)\] (\S.*?)\s*$')
FIELD_RE = re.compile(r'^- (\[[ xX]\] )?\*\*(.+?):\*\*(?: (.*?))?\s*$')
FENCE_RE = re.compile(r'^(\s*)(```|~~~)')
FENCE_RUN_RE = re.compile(r'^\s*(`{3,}|~{3,})')
NESTED_RE = re.compile(r'^\s+#{2,3} \[((?:BUG|FEAT)-\d+[a-z]*)\]')
KEY_RE = re.compile(r'^[A-Z][A-Z0-9]+-\d+$')
ANYKEY_RE = re.compile(r'\b[A-Z][A-Z0-9]+-\d+\b')
DATE_RE = re.compile(r'\b(\d{4}-\d{2}-\d{2})\b')
LEVELS = ('crit', 'high', 'med', 'low')
BUMPS = ('major', 'minor', 'patch')
# Where a finding was found (E33): the stage it escaped to, so `escapes` can count findings per stage.
FOUND_BY = ('build', 'panel-qa', 'panel-review', 'panel-security', 'protocol', 'gui-walkthrough', 'audit',
            'ci', 'human-qa', 'human-review', 'human-security', 'staging', 'production', 'user')
ACTIVE = {'bug': ('open', 'in-progress', 'fixed-pending-migration'),
          'feature': ('open', 'in-progress', 'shipped-pending-migration')}
CLOSE_REASONS = ('duplicate', 'wontfix', 'superseded', 'cannot-reproduce', 'not-a-defect')
CLOSED_RE = re.compile(r'migrated|shipped(?!-pending)|fixed(?!-pending)|closed|released|done|won.?t|wontfix|'
                       r'duplicate|superseded|rejected|cannot-reproduce|not-a-defect|obsolete|withdrawn|invalid', re.I)
SCHEMA = {
    'bug': ['Severity', 'Area', 'File(s)', 'Observation', 'Expected', 'Req', 'Depends on', 'Repro / Notes',
            'Found by?', 'Class?', 'Bump', 'Target?', 'Jira', 'Jira parent?', 'Bundle?', 'Assignee?', 'Status', 'Fix?', 'Docs?', 'Cross-ref?', 'Log?'],
    'feature': ['Priority', 'Area', 'File(s)', 'Req', 'Depends on', 'UI', 'Why', 'Approach',
                'Library / dependency notes', 'Acceptance criteria', 'Test plan', 'Out of scope',
                'Found by?', 'Class?', 'Bump', 'Target?', 'Jira', 'Jira parent?', 'Bundle?', 'Assignee?', 'Status', 'Implementation?', 'Docs?', 'Cross-ref?', 'Log?'],
}
ENUMS = {'Severity': LEVELS, 'Priority': LEVELS, 'Bump': BUMPS, 'Found by': FOUND_BY}
NO_UNKNOWN = {'Severity', 'Priority', 'Bump', 'Status', 'Jira', 'Jira parent', 'Bundle', 'Area', 'Target', 'Found by'}
TARGET_RE = re.compile(r'^(v\d+\.\d+\.\d+|unscheduled)$')
VERSION_NAME_RE = re.compile(r'^v\d+\.\d+\.\d+$')
ISSUE_TYPES = {'bug': 'Bug', 'feature': 'Story', 'bundle': 'Task', 'epic': 'Epic'}  # jira.issueTypes overrides each
BUNDLE_LABEL = 'cycle-bundle'
ALIASES = {'Blocked-on': 'Depends on', 'Blocked on': 'Depends on', 'Blocked by': 'Depends on',
           'Docs (required — do not close without them)': 'Docs', 'Parent': 'Jira parent',
           'Files': 'File(s)', 'File': 'File(s)', 'Repro': 'Repro / Notes', 'Notes': 'Repro / Notes',
           'Acceptance Criteria': 'Acceptance criteria', 'Test Plan': 'Test plan'}
PRIORITY_JIRA = {'crit': 'Highest', 'high': 'High', 'med': 'Medium', 'low': 'Low'}
TRACKER_FILES = ('bugs.md', 'features.md')


def fields_of(kind):
    return [f.rstrip('?') for f in SCHEMA[kind]]


def required_of(kind, jira=None):
    req = [f for f in SCHEMA[kind] if not f.endswith('?')]
    if not (jira_mode() == 'enforce' if jira is None else jira):
        req.remove('Jira')  # Jira stays an allowed, ordered field; required only when enforced
    return req


def kind_of(path):
    b = os.path.basename(path).lower()
    return 'bug' if b == 'bugs.md' else 'feature' if b == 'features.md' else None


def rel_or_abs(p, root):
    """os.path.relpath, or the absolute path when P and ROOT sit on different Windows drives."""
    try:
        return os.path.relpath(p, root)
    except ValueError:
        return os.path.abspath(p)


def today():
    return datetime.date.today().isoformat()


# ---------------------------------------------------------------- entry model

class Entry:
    def __init__(self, eid, title):
        self.id, self.title = eid, title
        self.fields = []     # [name, [inline, cont...]]
        self.box = None      # ' ' / 'x' on the first field, None when absent
        self.stray = []      # lines before the first field
        self.boxes = 0       # fields carrying a checkbox

    def find(self, name):
        for f in self.fields:
            if f[0] == name:
                return f
        return None

    def value(self, name):
        f = self.find(name)
        return f[1][0].strip() if f else None

    def text(self, name):
        f = self.find(name)
        if not f:
            return None
        cont = [l[2:] if l.startswith('  ') else l for l in f[1][1:]]
        return '\n'.join([f[1][0]] + cont).strip('\n')

    def set(self, kind, name, value):
        lines = value_lines(value)
        f = self.find(name)
        if f:
            f[1] = lines
            return
        order = fields_of(kind)
        pos = order.index(name) if name in order else len(order)
        idx = len(self.fields)
        for i, (n, _) in enumerate(self.fields):
            if n in order and order.index(n) > pos:
                idx = i
                break
        self.fields.insert(idx, [name, lines])

    def drop(self, name):
        self.fields = [f for f in self.fields if f[0] != name]

    def status(self):
        v = self.value('Status')
        return (v or '').strip('`* ').lower()

    def render(self):
        out = ['### [%s] %s' % (self.id, self.title)]
        for i, (name, lines) in enumerate(self.fields):
            box = '[%s] ' % (self.box or ' ') if i == 0 else ''
            inline = lines[0] if lines else ''
            out.append(('- %s**%s:** %s' % (box, name, inline)).rstrip())
            cont = list(lines[1:])
            while cont and not cont[-1].strip():
                cont.pop()
            out += cont
        return '\n'.join(out) + '\n'


def value_lines(value):
    value = (value or '').replace('\r\n', '\n').strip('\n')
    parts = value.split('\n')
    if re.match(r'^\s*([-*] |\d+\. |```|~~~)', parts[0]):
        parts = [''] + parts  # a list or a code block starts on its own line under the field
    first, rest = parts[0].strip(), parts[1:]
    return [first] + [('  ' + l if l.strip() and not l.startswith('  ') else l.rstrip()) for l in rest]


def parse_entry(text):
    lines = text.rstrip('\n').split('\n')
    m = HEAD_RE.match(lines[0])
    if m:
        e = Entry(m.group(1), m.group(2))
    else:
        m2 = re.match(r'^###\s+\[([^\]]+)\]\s*(.*)$', lines[0])
        e = Entry(m2.group(1) if m2 else '?', (m2.group(2) if m2 else lines[0]).strip())
        e.badhead = True
    cur, fence = None, False
    for line in lines[1:]:
        fm = FENCE_RE.match(line)
        if not fence:
            m = FIELD_RE.match(line)
            if m:
                cur = [m.group(2).strip(), [m.group(3) or '']]
                if m.group(1):
                    e.boxes += 1
                    if not e.fields:
                        e.box = 'x' if 'x' in m.group(1).lower() else ' '
                e.fields.append(cur)
                continue
        (cur[1] if cur else e.stray).append(line)
        if fm:
            fence = not fence
    if cur is None:
        e.stray = [l for l in e.stray]
    return e


def fence_step(fence, line):
    """Fence state after LINE (None = outside code). CommonMark: a fence is a line-start run of 3+ `
    or ~ (an inline ``` in a field value is not one, nor a ` run followed by more `); it closes on a
    bare run of the same character at least as long as the opener."""
    m = FENCE_RUN_RE.match(line)
    if not m:
        return fence
    run, rest = m.group(1), line[m.end():]
    if fence is None:
        return None if run[0] == '`' and '`' in rest else run
    return None if run[0] == fence[0] and len(run) >= len(fence) and not rest.strip() else fence


def split_blocks(text):
    """Split at `## ` and `### [` lines outside fenced code; ''.join(result) == text."""
    chunks, cur, fence = [], [], None
    for line in text.split('\n'):
        if fence is None and cur and line.startswith(('### [', '## ')):
            chunks.append('\n'.join(cur) + '\n')
            cur = []
        cur.append(line)
        fence = fence_step(fence, line)
    chunks.append('\n'.join(cur))
    return chunks


# ---------------------------------------------------------------- lint

def lint_entry(e, kind):
    """Return [(code, severity, message)]; severity is 'E' or 'W'."""
    out = []
    if getattr(e, 'badhead', False):
        out.append(('HEAD', 'E', 'heading must be "### [BUG|FEAT-<digits>] <title>"'))
    if kind == 'bug' and not e.id.startswith('BUG-') or kind == 'feature' and not e.id.startswith('FEAT-'):
        out.append(('KIND', 'E', '%s filed in the %s tracker' % (e.id, kind)))
    if any(l.strip() for l in e.stray):
        out.append(('STRAY', 'E', 'text between the heading and the first field'))
    names = [f[0] for f in e.fields]
    allowed = fields_of(kind)
    for n in names:
        if n not in allowed:
            out.append(('FIELD', 'E', 'unknown field "%s" (fold it into Log)' % n))
    for n in set(names):
        if names.count(n) > 1:
            out.append(('DUPFIELD', 'E', 'field "%s" appears %d times' % (n, names.count(n))))
    for n in required_of(kind):
        if n not in names:
            out.append(('MISSING', 'E', 'required field "%s" missing' % n))
    known = [n for n in names if n in allowed]
    if known != sorted(known, key=allowed.index):
        out.append(('ORDER', 'E', 'fields out of canonical order (fixable)'))
    if e.box is None or e.boxes != 1:
        out.append(('BOX', 'E', 'exactly the first field carries the checkbox (fixable)'))
    st = e.status()
    if st and st not in ACTIVE[kind]:
        if CLOSED_RE.search(st):
            out.append(('CLOSED', 'E', 'status "%s": remove with `migrate` or `close`' % st))
        else:
            out.append(('STATUS', 'E', 'status "%s" not in %s' % (st, '|'.join(ACTIVE[kind]))))
    elif st and e.box is not None and (e.box == 'x') != st.endswith('pending-migration'):
        out.append(('BOX', 'E', 'checkbox must be ticked exactly when the status is *-pending-migration (fixable)'))
    for n, vals in ENUMS.items():
        v = e.value(n)
        if v is not None and n in allowed and v not in vals:
            out.append(('ENUM', 'E', '%s "%s" not in %s' % (n, v, '|'.join(vals))))
    ui = (e.value('UI') or '').strip()
    if ui.lower().startswith('deferred') and not re.search(r'\b(?:[A-Z][A-Z0-9]*-)?(?:FR|FEAT|BUG)-\d+\b|\b[A-Z][A-Z0-9]+-\d+\b', ui):
        out.append(('UIDEFER', 'W', '`UI: deferred (...)` names no FR or ticket id that delivers the UI (spec ui-ux.md §1)'))
    j = e.value('Jira')
    if j is not None and j != 'pending' and not KEY_RE.match(j):
        out.append(('JIRA', 'E', 'Jira must be a key or `pending`, got "%s"' % j[:40]))
    tg = e.value('Target')
    if tg is not None and not TARGET_RE.match(tg):
        out.append(('TARGET', 'E', 'Target must be vX.Y.Z or `unscheduled`, got "%s"' % tg[:40]))
    area = e.value('Area') or ''
    if re.search(r'\s/\s|[()—]', area):
        out.append(('AREA', 'W', 'Area is comma-separated tags; move notes to Log ("%s")' % area[:40]))
    if epics_required() and not e.value('Jira parent'):
        out.append(('NOEPIC', 'W', 'no `Jira parent` (epic); pick one from `jira epics`'))
    if j == 'pending' and jira_mode() == 'enforce':
        out.append(('PENDING', 'W', 'no Jira issue yet: run `jira sync`'))
    for n in ('Jira parent', 'Bundle'):
        v = e.value(n)
        if v is not None and not KEY_RE.match(v):
            out.append(('JIRA', 'E', '%s must be a key, got "%s"' % (n, v[:40])))
    for name, lines in e.fields:
        if (lines[0] if lines else '').strip().lower() == 'unknown':
            out.append(('UNKNOWN' if name not in NO_UNKNOWN else 'ENUM', 'W' if name not in NO_UNKNOWN else 'E',
                        '%s is `unknown` (pre-schema entry)' % name))
        fence_indent = None
        for l in lines[1:]:
            fm = FENCE_RE.match(l)
            if fence_indent is not None:
                if fm and len(fm.group(1)) <= fence_indent:
                    fence_indent = None
                continue
            if fm:
                if not fm.group(1):
                    out.append(('INDENT', 'E', '%s: fenced block must be indented two spaces (fixable)' % name))
                fence_indent = len(fm.group(1))
                continue
            if l.strip() and not l.startswith((' ', '\t')):
                out.append(('INDENT', 'E', '%s: continuation line not indented (fixable)' % name))
                break
    if not e.title.strip():
        out.append(('HEAD', 'E', 'empty title'))
    return [(c, s, m) for c, s, m in dict.fromkeys(out)]


def fix_entry(e, kind):
    """Safe mechanical repairs: order, checkbox, indentation, blank runs."""
    allowed = fields_of(kind)
    if 'Jira' in required_of(kind) and e.find('Jira') is None:
        e.set(kind, 'Jira', 'pending')  # Jira enforced after filing: the placeholder `jira sync` fills
    known = [f for f in e.fields if f[0] in allowed]
    other = [f for f in e.fields if f[0] not in allowed]
    known.sort(key=lambda f: allowed.index(f[0]))
    e.fields = known + other
    st = e.status()
    e.box = 'x' if st.endswith('pending-migration') else ' '
    e.boxes = 1
    for f in e.fields:
        f[1] = [f[1][0]] + indent_cont(f[1][1:])
    return e


def indent_cont(lines):
    out, fence_pad = [], None
    for l in lines:
        fm = FENCE_RE.match(l)
        if fence_pad is not None:
            out.append(fence_pad + l if l.strip() else l)
            if fm and not fm.group(1):
                fence_pad = None
            continue
        if fm and not fm.group(1):
            fence_pad = '  '
            out.append('  ' + l)
            continue
        if fm:
            out.append(l)
            continue
        out.append('  ' + l if l.strip() and not l.startswith((' ', '\t')) else l.rstrip())
    while out and not out[-1].strip():
        out.pop()
    # collapse 2+ blank lines
    res = []
    for l in out:
        if not l.strip() and res and not res[-1].strip():
            continue
        res.append(l)
    return res


# ---------------------------------------------------------------- adopt (legacy -> format 2)

def adopt_entry(e, kind, notes):
    """Normalize a legacy entry in place. Appends human follow-ups to notes."""
    allowed = fields_of(kind)
    log = []
    kept = {}
    old_log = None
    if any(l.strip() for l in e.stray):
        txt = ' '.join(l.strip().lstrip('> ').strip() for l in e.stray if l.strip())
        log.append(['Note: ' + txt, []])
    e.stray = []
    for name, lines in e.fields:
        canon = name if name in allowed else ALIASES.get(name)
        base = re.sub(r'\s*\(.*\)\s*$', '', name).strip()
        if not canon and base in allowed and base not in kept and base != 'Log':
            canon, q = base, name[len(base):].strip()
            lines = [('%s %s' % (q, lines[0])).strip()] + lines[1:]
        if name == 'Dependencies' and kind == 'feature':
            canon = 'Library / dependency notes'
        if canon == 'Log' and canon not in kept:
            old_log = lines
            kept['Log'] = True
            continue
        if canon and canon not in kept:
            kept[canon] = lines
        elif canon == 'Depends on' and canon in kept:
            kept[canon] = [kept[canon][0].rstrip('. ') + ', ' + lines[0]] + kept[canon][1:] + lines[1:]
        else:
            log.append([name + ': ' + (lines[0] or ''), lines[1:]])
    kept.pop('Log', None)

    def enum_field(fname, allowed_vals, remap=None):
        lines = kept.get(fname)
        if lines is None:
            return
        raw = lines[0].strip()
        m = re.match(r'^[`*\s]*([A-Za-z][A-Za-z-]*)', raw)
        tok = (m.group(1).lower() if m else '')
        if remap:
            tok = remap.get(tok, tok)
        rest = raw[m.end():].strip(' `*—–-:;,.()') if m else raw
        if tok in allowed_vals:
            kept[fname] = [tok]
            if rest or any(l.strip() for l in lines[1:]):
                log.append(['%s note: %s' % (fname, rest), lines[1:]])
        elif fname == 'Bump':
            kept[fname] = ['patch' if kind == 'bug' else 'minor']
            log.append(['Bump note: %s (defaulted at adoption)' % raw, lines[1:]])
        else:
            notes.append('%s: %s "%s" needs a hand decision' % (e.id, fname, raw[:60]))

    enum_field('Severity' if kind == 'bug' else 'Priority', LEVELS,
               {'critical': 'crit', 'medium': 'med', 'blocker': 'crit', 'major': 'high', 'minor': 'low'})
    enum_field('Bump', BUMPS)
    enum_field('Status', ACTIVE[kind], {'shipped-pending-migration': ACTIVE[kind][2],
                                        'fixed-pending-migration': ACTIVE[kind][2], 'inprogress': 'in-progress',
                                        'in_progress': 'in-progress', 'blocked': 'in-progress'})
    # Area: comma-separated tags; "a / b" splits, a parenthetical or dash note goes to Log
    al = kept.get('Area')
    if al is not None:
        raw = ' '.join([al[0]] + [l.strip() for l in al[1:]]).strip()
        m = re.search(r'\s*[(—].*$', raw)
        tags = [t.strip(' `*') for t in re.split(r',|\s/\s', raw[:m.start()] if m else raw) if t.strip(' `*')]
        kept['Area'] = [', '.join(dict.fromkeys(tags)) or 'unknown']
        if m:
            log.append(['Area note: ' + m.group(0).strip(' ()—'), []])
    # Jira
    jl = kept.get('Jira')
    if jl is not None:
        raw = ' '.join([jl[0]] + [l.strip() for l in jl[1:]]).strip()
        m = re.match(r'^[`*\s]*([A-Z][A-Z0-9]+-\d+)\b\.?', raw)
        if m:
            key, rest = m.group(1), raw[m.end():].strip(' .—–-:;,')
            kept['Jira'] = [key]
            m2 = re.search(r'\bepic\s+(%s-\d+)' % re.escape(key.split('-')[0]), rest, re.I)
            if m2 and 'Jira parent' not in kept:  # bundles are links, not parents: only an epic counts
                kept['Jira parent'] = [m2.group(1)]
            if rest:
                log.append(['Jira note: ' + rest.strip('()'), []])
        else:
            kept['Jira'] = ['pending']
            info = raw.strip('() ')
            if info and not re.fullmatch(r'(unfiled|tbd|pending|new ticket to be raised|none|n/a)\.?', info, re.I):
                log.append(['Jira note: ' + info, []])
    jp = kept.get('Jira parent')
    if jp is not None:
        m = ANYKEY_RE.search(' '.join(jp))
        if m and re.match(r'(BUG|FEAT)-', m.group(0)):
            m = None  # a tracker id, not a Jira key
        if m:
            rest = ' '.join(jp).replace(m.group(0), '').strip(' .—–-:;,()')
            kept['Jira parent'] = [m.group(0)]
            if rest:
                log.append(['Jira parent note: ' + rest, []])
        else:
            log.append(['Parent: ' + ' '.join(jp), []])
            kept.pop('Jira parent')
    # defaults for missing required fields
    for n in required_of(kind):
        if n in kept:
            continue
        if n == 'Status':
            kept[n] = ['open']
            log.append(['Status note: no Status line; set `open` at adoption (entry sat under ## Open)', []])
        elif n == 'Bump':
            kept[n] = ['patch' if kind == 'bug' else 'minor']
        elif n == 'Jira':
            kept[n] = ['pending']
        elif n in NO_UNKNOWN:
            kept[n] = ['unknown']
            notes.append('%s: missing %s needs a hand decision' % (e.id, n))
        else:
            kept[n] = ['unknown']
    # rebuild
    log_lines = list(old_log[1:]) if old_log else []
    items, cur = [], None
    for l in log_lines:
        if l.startswith('  - '):
            cur = [l]
            items.append(cur)
        elif cur is not None:
            cur.append(l)
        else:
            items.append([l])
    keep_items = []
    for it in items:
        m = re.match(r'^  - ([^:(]+?) ?(\([^)]*\))?\s*:\s?(.*)$', it[0])
        name = m.group(1).strip() if m else ''
        if m and name in allowed and name != 'Log' and \
                (name not in kept or (kept[name][0] or '').strip().lower() in ('unknown', '')):
            q = (m.group(2) or '').strip()
            kept[name] = [('%s %s' % (q, m.group(3))).strip()] + [l[2:] if l.startswith('    ') else l for l in it[1:]]
            continue
        keep_items.append(it)
    log_lines = [l for it in keep_items for l in it]
    e.fields = [[n, kept[n]] for n in allowed if n in kept]
    if old_log and old_log[0].strip():
        log_lines.insert(0, '  - ' + old_log[0].strip())
    for head, cont in log:
        log_lines.append('  - ' + head.strip())
        log_lines += ['  ' + l if l.strip() else '' for l in indent_cont(cont)]
    if log_lines:
        e.fields.append(['Log', [''] + log_lines])
    e.fields = [f for f in e.fields]
    if getattr(e, 'badhead', False):
        notes.append('%s: malformed heading needs a hand fix' % e.id)
    fix_entry(e, kind)
    return e


# ---------------------------------------------------------------- repo + files

def git(*args, cwd=None, binary=False):
    r = subprocess.run(['git'] + list(args), capture_output=True, cwd=cwd)
    if r.returncode != 0:
        return None
    return r.stdout if binary else r.stdout.decode('utf-8', errors='replace').strip()


_ROOT = []


def repo_root():
    if not _ROOT:
        _ROOT.append(git('rev-parse', '--show-toplevel') or os.getcwd())
    return _ROOT[0]


def load_config(root):
    p = os.path.join(root, '.cycle', 'tracker.json')
    if os.path.exists(p):
        with open(p, encoding='utf-8') as f:
            return json.load(f)
    return {}


_MODE = {}


def jira_mode(root=None):
    """'enforce' | 'optional' | 'off', from .cycle/tracker.json (set at protocol bootstrap)."""
    root = root or repo_root()
    if root not in _MODE:
        j = load_config(root).get('jira')
        _MODE[root] = 'off' if not j else ('enforce' if j.get('enforce', True) else 'optional')
    return _MODE[root]


def epics_required(root=None):
    root = root or repo_root()
    key = ('epics', root)
    if key not in _MODE:
        j = load_config(root).get('jira') or {}
        _MODE[key] = jira_mode(root) != 'off' and bool((j.get('epics') or {}).get('required'))
    return _MODE[key]


def strict(root):
    return load_config(root).get('format') == 2


def tracker_files(root):
    ls = git('ls-files', cwd=root)
    names = ls.splitlines() if ls is not None else []
    out = [os.path.join(root, f) for f in names if os.path.basename(f) in TRACKER_FILES and 'node_modules/' not in f]
    return sorted(out)


def app_of(root, path, cfg):
    rel = rel_or_abs(os.path.dirname(os.path.abspath(path)), root).replace('\\', '/')
    apps = cfg.get('apps', {})
    if rel in apps:
        return apps[rel]
    return os.path.basename(os.path.abspath(root)) if rel == '.' else os.path.basename(rel)


def read(path):
    with open(path, 'rb') as f:
        raw = f.read().decode('utf-8', errors='replace')
    return raw.replace('\r\n', '\n')


def write(path, text):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


class TrackerFile:
    """A format-2 tracker: preamble, `## Open`, entries."""

    def __init__(self, path):
        self.path, self.kind = path, kind_of(path)
        text = read(path)
        m = re.search(r'(?m)^## Open\s*$', text)
        if m:
            self.pre, body = text[:m.start()], text[m.end():]
        else:
            self.pre, body = text.rstrip('\n') + '\n\n', ''
        self.tail = ''
        parts = re.split(r'(?m)^(?=### \[)', body)
        self.intro = parts[0]
        self.entries = [parse_entry(p) for p in parts[1:]]

    def get(self, eid):
        hits = [e for e in self.entries if e.id == eid]
        return hits[0] if hits else None

    def remove(self, eid):
        self.entries = [e for e in self.entries if e.id != eid]

    def render(self):
        intro = self.intro.strip('\n')
        out = self.pre.rstrip('\n') + '\n\n## Open\n\n'
        if intro and not re.fullmatch(r'[-\s]*', intro):
            out += intro + '\n\n'
        out += '\n'.join(e.render() for e in self.entries)
        return out

    def save(self):
        write(self.path, self.render())


def all_ids(root):
    ids = {}
    for p in tracker_files(root):
        for m in re.finditer(r'(?m)^### \[((?:BUG|FEAT)-\d+[a-z]*)\]', read(p)):
            ids.setdefault(m.group(1), []).append(p)
    return ids


def locate(root, eid, tracker=None, app=None):
    cfg = load_config(root)
    if tracker:
        paths = [os.path.abspath(tracker)]
    else:
        paths = [p for p in tracker_files(root) if ('### [%s]' % eid) in read(p)]
        if app:
            paths = [p for p in paths if app_of(root, p, cfg) == app]
    if not paths:
        sys.exit('%s: not found in any tracker' % eid)
    if len(paths) > 1:
        sys.exit('%s is filed in %d trackers (%s); pass --tracker or --app' % (
            eid, len(paths), ', '.join(app_of(root, p, cfg) for p in paths)))
    tf = TrackerFile(paths[0])
    e = tf.get(eid)
    if not e:
        sys.exit('%s: not found in %s' % (eid, paths[0]))
    return tf, e


def opts(argv, flags=(), multi=()):
    """Tiny parser: --name value / --flag; returns (dict, positionals)."""
    o, pos, i = {}, [], 0
    while i < len(argv):
        a = argv[i]
        if a.startswith('--'):
            k = a[2:]
            if '=' in k:
                k, v = k.split('=', 1)
            elif k in flags:
                v = True
            else:
                i += 1
                if i >= len(argv):
                    sys.exit('--%s needs a value' % k)
                v = argv[i]
            if k in multi:
                o.setdefault(k, []).append(v)
            else:
                o[k] = v
        elif a == '-o':
            i += 1
            o['out'] = argv[i]
        else:
            pos.append(a)
        i += 1
    return o, pos


def check_or_die(e, kind):
    errs = [x for x in lint_entry(e, kind) if x[1] == 'E']
    if errs:
        sys.exit('%s rejected:\n%s' % (e.id, '\n'.join('  %s %s' % (c, m) for c, _, m in errs)))


# ---------------------------------------------------------------- commands: writers

def _new_entry(root, path, kind, data, taken, eid=None):
    """Build and validate one entry (no write). `taken` gains the id it allocates."""
    data = dict(data)
    title = (data.pop('title', None) or data.pop('Title', '') or '').strip()
    if not title:
        sys.exit('add: a title is required')
    pref = 'BUG' if kind == 'bug' else 'FEAT'
    if eid:
        if not eid.startswith(pref + '-'):
            sys.exit('add: %s does not belong in the %s tracker' % (eid, kind))
        if path in [os.path.abspath(p) for p in taken.get(eid, [])]:
            sys.exit('add: %s already exists in this tracker' % eid)
    else:
        n = int(time.time())
        while '%s-%d' % (pref, n) in taken:
            n += 1
        eid = '%s-%d' % (pref, n)
    taken.setdefault(eid, []).append(path)
    e = Entry(eid, title)
    for k, v in data.items():
        k = ALIASES.get(k, k)
        if k in ('Status', 'Jira', 'tracker', 'prov'):
            continue
        e.set(kind, k, str(v))
    if jira_mode(root) == 'enforce':
        e.set(kind, 'Jira', 'pending')
    e.set(kind, 'Status', 'open')
    if not e.value('Bump'):
        e.set(kind, 'Bump', 'patch' if kind == 'bug' else 'minor')
    e.box = ' '
    e.boxes = 1
    return e


def _tracker_kind(path, who='add'):
    kind = kind_of(path)
    if not kind:
        sys.exit('%s: --tracker must be a bugs.md or features.md (%s)' % (who, path))
    return kind


def _taken_with(root, paths):
    taken = all_ids(root)
    for path in set(paths):
        for m in re.finditer(r'(?m)^### \[((?:BUG|FEAT)-\d+[a-z]*)\]', read(path) if os.path.exists(path) else ''):
            taken.setdefault(m.group(1), []).append(path)  # the target counts even before git tracks it
    return taken


def cmd_add(argv):
    """add --tracker PATH (--json FILE|- | --field 'Name=value'...) [--id ID] [--no-jira] [--dry-run]

    --json with an array files a batch: each item may name its own "tracker" and a provisional
    "prov" id; "Depends on" and "Cross-ref" citing another item's prov id get its real id.
    Every entry is validated before anything is written: one invalid entry writes nothing."""
    o, _ = opts(argv, flags=('no-jira', 'dry-run'), multi=('field',))
    root = repo_root()
    data = {}
    if 'json' in o:
        src = sys.stdin.read() if o['json'] == '-' else read(o['json'])
        data = json.loads(src)
    if isinstance(data, list):
        return _add_batch(root, o, data)
    if 'tracker' not in o:
        sys.exit('add: --tracker PATH is required')
    path = os.path.abspath(o['tracker'])
    kind = _tracker_kind(path)
    for f in o.get('field', []):
        k, _, v = f.partition('=')
        data[k.strip()] = v
    e = _new_entry(root, path, kind, data, _taken_with(root, [path]), o.get('id'))
    fix_entry(e, kind)
    check_or_die(e, kind)
    if o.get('dry-run'):
        print(e.render())
        return 0
    tf = TrackerFile(path)
    tf.entries.append(e)
    tf.save()
    print('added %s to %s' % (e.id, rel_or_abs(path, root)))
    if jira_mode(root) != 'off' and not o.get('no-jira'):
        jira_for_entries(root, [(path, e.id)], dry=False, quiet_missing_creds=True)
    return 0


def _add_batch(root, o, items):
    if not items or not all(isinstance(x, dict) for x in items):
        sys.exit('add: --json array must hold objects')
    paths = []
    for n, it in enumerate(items, 1):
        t = it.get('tracker') or o.get('tracker')
        if not t:
            sys.exit('add: item %d has no "tracker" and no --tracker was given' % n)
        paths.append(os.path.abspath(t))
    provs = [str(it.get('prov', '')).strip() for it in items]
    dup = sorted({p for p in provs if p and provs.count(p) > 1})
    if dup:
        sys.exit('add: provisional ids used twice: %s' % ', '.join(dup))
    taken = _taken_with(root, paths)
    built = []
    for it, path in zip(items, paths):
        built.append((path, _tracker_kind(path), _new_entry(root, path, _tracker_kind(path), it, taken)))
    real = {p: e.id for p, (_, _, e) in zip(provs, built) if p}
    pat = re.compile(r'(?<![\w-])(%s)(?![\w-])' % '|'.join(re.escape(p) for p in sorted(real, key=len, reverse=True))) if real else None
    for path, kind, e in built:
        for field in ('Depends on', 'Cross-ref'):
            v = e.value(field) or ''
            if v and pat:
                e.set(kind, field, pat.sub(lambda m: real[m.group(1)], v))
        fix_entry(e, kind)
        check_or_die(e, kind)
    if o.get('dry-run'):
        for _, _, e in built:
            print(e.render())
        print('add: %d entries valid (dry run, nothing written)' % len(built))
        return 0
    by_path = {}
    for path, _, e in built:
        by_path.setdefault(path, []).append(e)
    for path, es in by_path.items():
        tf = TrackerFile(path)
        tf.entries.extend(es)
        tf.save()
    for (path, _, e), p in zip(built, provs):
        print('added %s to %s%s' % (e.id, rel_or_abs(path, root), ' (was %s)' % p if p else ''))
    if jira_mode(root) != 'off' and not o.get('no-jira'):
        jira_for_entries(root, [(path, e.id) for path, _, e in built], dry=False, quiet_missing_creds=True)
    return 0


# Fields whose change moves Jira or the entry's identity: one `set` call each, never a batch.
BATCH_SET_REFUSED = ('Status', 'Target', 'Assignee', 'Jira', 'Jira parent', 'Bundle', 'title')


def set_batch(root, items):
    """set --json: many {id, field, value} edits validated together and written once per tracker.

    All or nothing: a malformed item, an unknown id, a refused field, or an entry that fails the
    schema exits before any tracker is written. Optional per-item `tracker` / `app` as in `set`.
    """
    if not isinstance(items, list) or not items:
        sys.exit('set --json: expected a non-empty JSON array of {"id", "field", "value"}')
    files, entries = {}, {}
    for n, it in enumerate(items, 1):
        if not isinstance(it, dict) or not all(isinstance(it.get(k), str) for k in ('id', 'field', 'value')):
            sys.exit('set --json: item %d needs string "id", "field" and "value"' % n)
        field = ALIASES.get(it['field'], it['field'])
        if field in BATCH_SET_REFUSED or field.lower() == 'title':
            sys.exit('set --json: item %d: %s moves Jira or identity; use `set %s %s ...` on its own'
                     % (n, field, it['id'], field))
        path = locate(root, it['id'], it.get('tracker'), it.get('app'))[0].path
        tf = files.setdefault(path, TrackerFile(path))
        e = tf.get(it['id'])
        e.set(tf.kind, field, it['value'])
        entries[(path, e.id)] = (tf, e)
    for tf, e in entries.values():
        fix_entry(e, tf.kind)
        check_or_die(e, tf.kind)
    for tf in files.values():
        tf.save()
    print('set %d field(s) on %d entries in %d tracker(s)' % (len(items), len(entries), len(files)))
    return 0


def cmd_set(argv):
    """set ID FIELD (VALUE | --file F | -) [--tracker P | --app A] [--no-jira]
    set --json F|-      a JSON array of {id, field, value[, tracker, app]}: one write, all or nothing"""
    o, pos = opts(argv, flags=('no-jira',))
    if 'json' in o:
        src = sys.stdin.read() if o['json'] == '-' else read(o['json'])
        try:
            items = json.loads(src)
        except ValueError as ex:
            sys.exit('set --json: not JSON (%s)' % ex)
        return set_batch(repo_root(), items)
    if len(pos) < 2:
        sys.exit('usage: set ID FIELD VALUE|-|--file F')
    eid, field = pos[0], ALIASES.get(pos[1], pos[1])
    if 'file' in o:
        value = read(o['file'])
    elif len(pos) > 2 and pos[2] == '-':
        value = sys.stdin.read()
    elif len(pos) > 2:
        value = ' '.join(pos[2:])
    else:
        sys.exit('set: missing value')
    root = repo_root()
    tf, e = locate(root, eid, o.get('tracker'), o.get('app'))
    take = field == 'Assignee' and value.strip().lower() == 'me'
    start = field == 'Status' and value.strip().strip('`* ').lower() == 'in-progress'
    jira = None if o.get('no-jira') or not (take or field in ('Status', 'Target')) else jira_or_none(root)
    if field.lower() == 'title':
        e.title = value.strip()
    elif not take:
        e.set(tf.kind, field, value)
    fix_entry(e, tf.kind)
    check_or_die(e, tf.kind)
    key = e.value('Jira') or ''
    jira = jira if jira and KEY_RE.match(key) else None
    if take or start:
        claim_entry(e, tf.kind, jira and jira_claim(jira, key, force=take), whoami(jira), take)
    tf.save()
    print('%s: %s set' % (eid, field))
    if not jira:
        return 0
    if field == 'Target' and target_of(e):
        jira_target(jira, key, target_of(e))
    if field == 'Status':
        wf = fit_workflow(jira, workflow(load_config(root)))
        target = status_target(e.status(), wf)
        if target:
            jira_move(jira, key, target, wf)
        if KEY_RE.match(e.value('Bundle') or ''):
            if start:
                jira_claim(jira, e.value('Bundle'))
            bundle_follow(root, jira, wf, e.value('Bundle'))
    return 0


def whoami(jira):
    """Who starts the work: the Jira token's user when Jira is reachable, else git user.name."""
    if jira:
        try:
            return jira.myself()[1]
        except NET_ERRORS as ex:
            print('  warning: Jira user not read (%s); using git user.name' % ex)
    return git('config', 'user.name') or None


def claim_entry(e, kind, holder, me, take):
    """Write Assignee. HOLDER (the Jira issue's assignee after the claim) wins when Jira answered;
    otherwise starting work fills an empty Assignee with ME and never overwrites a teammate's."""
    held = e.value('Assignee')
    name = holder or (me if take or not held else None)
    if take and not name:
        sys.exit('set: no Jira user or git user.name to assign')
    if held and not name and held != me:
        print('  %s: left assigned to %s (`set %s Assignee me` takes it)' % (e.id, held, e.id))
    if name and name != held:
        e.set(kind, 'Assignee', name)
        print('  %s: Assignee %s' % (e.id, name))


def cmd_log(argv):
    """log ID TEXT [--label L] [--date YYYY-MM-DD] [--tracker P | --app A]"""
    o, pos = opts(argv)
    if len(pos) < 2:
        sys.exit('usage: log ID TEXT')
    root = repo_root()
    tf, e = locate(root, pos[0], o.get('tracker'), o.get('app'))
    head = o.get('date', today()) + (' ' + o['label'] if o.get('label') else '') + ': '
    f = e.find('Log')
    lines = (f[1] if f else ['']) + ['  - ' + head + ' '.join(pos[1:])]
    e.set(tf.kind, 'Log', '')
    e.find('Log')[1] = lines
    fix_entry(e, tf.kind)
    tf.save()
    print('%s: logged' % pos[0])
    return 0


CL_SECTIONS = ('Added', 'Changed', 'Fixed', 'Removed', 'Security')


def changelog_line(e):
    req = e.value('Req') or ''
    req = '' if req.lower().startswith(('none', 'unknown')) else ' (Req: %s)' % req
    key = e.value('Jira') or ''
    key = key + ' ' if KEY_RE.match(key) else ''
    return '- [%s] %s%s%s [%s]' % (e.id, key, e.title, req, e.value('Bump'))


def changelog_insert(path, line, section, eid):
    text = read(path) if os.path.exists(path) else '# Changelog\n\n## Unreleased\n'
    lines = text.split('\n')
    u = next((i for i, l in enumerate(lines) if re.match(r'^## \[?Unreleased\]?\s*$', l, re.I)), None)
    if u is None:
        h = next((i for i, l in enumerate(lines) if l.startswith('## ')), len(lines))
        lines[h:h] = ['## Unreleased', '']
        u = h
    end = next((i for i in range(u + 1, len(lines)) if lines[i].startswith('## ')), len(lines))
    if any(l.startswith(('- [%s]' % eid, '* [%s]' % eid)) for l in lines):
        return False  # already in the ledger (a hotfix line, or a re-run)
    s = next((i for i in range(u + 1, end) if re.match(r'^### %s\s*$' % section, lines[i])), None)
    if s is None:
        ins = end
        while ins > u + 1 and not lines[ins - 1].strip():
            ins -= 1
        lines[ins:ins] = ['', '### ' + section, '']
        s = ins + 1
        end += 3
    se = next((i for i in range(s + 1, end) if lines[i].startswith(('### ', '## '))), end)
    last = s
    for i in range(s + 1, se):
        if lines[i].strip():
            last = i
    if last == s:
        lines[s + 1:s + 1] = ['', line] if (s + 1 >= len(lines) or lines[s + 1].strip()) else [line]
        if lines[s + 1] == '':
            pass
    else:
        lines[last + 1:last + 1] = [line]
    out = '\n'.join(lines)
    out = re.sub(r'(### [A-Za-z]+)\n(- \[)', r'\1\n\n\2', out)
    write(path, out if out.endswith('\n') else out + '\n')
    return True


def cmd_migrate(argv):
    """migrate [ID...] [--all] [--section S] [--tracker P | --app A] [--skip-gate] [--no-jira]"""
    o, pos = opts(argv, flags=('all', 'skip-gate', 'no-jira'))
    root = repo_root()
    targets = []
    if o.get('all'):
        paths = [os.path.abspath(o['tracker'])] if o.get('tracker') else tracker_files(root)
        for p in paths:
            for e in TrackerFile(p).entries:
                if e.status().endswith('pending-migration'):
                    targets.append((p, e.id))
    else:
        for eid in pos:
            tf, e = locate(root, eid, o.get('tracker'), o.get('app'))
            targets.append((tf.path, eid))
    done, refused, keys = [], [], []
    wf = workflow(load_config(root))
    jira = None if o.get('no-jira') else jira_or_none(root)
    if jira:
        wf = fit_workflow(jira, wf)
    gate = wf['gate'] and not o.get('skip-gate')
    check = (gate or wf['review']) and jira and not o.get('skip-gate')
    st = {}
    bundles = set()
    if check:
        want = []
        for p, eid in targets:
            ent = TrackerFile(p).get(eid)
            for k in (ent.value('Jira') or '', ent.value('Bundle') or ''):
                if KEY_RE.match(k):
                    want.append(k)
        try:
            st = jira.statuses(want)
        except NET_ERRORS as ex:
            sys.exit('migrate: cannot read Jira statuses for the QA gate (%s); retry, or --skip-gate' % ex)
    waiting = []
    for p, eid in targets:
        tf = TrackerFile(p)
        e = tf.get(eid)
        if not e.status().endswith('pending-migration'):
            refused.append('%s (status %s)' % (eid, e.status()))
            continue
        if jira_mode(root) == 'enforce' and not KEY_RE.match(e.value('Jira') or ''):
            refused.append('%s (no Jira key: run `jira sync` first)' % eid)
            continue
        key = e.value('Jira') or ''
        cl = os.path.join(os.path.dirname(p), 'CHANGELOG.md')
        shipped = os.path.exists(cl) and re.search(r'(?m)^[-*] \[%s\]' % re.escape(eid), read(cl))
        if gate and not jira and not shipped:
            refused.append('%s (QA gate: Jira credentials missing; run `jira doctor`, or --skip-gate)' % eid)
            continue
        if check and not shipped:  # a hotfix line in the ledger: already shipped, no QA gate
            gk = gate_key(e)  # a bundle member's QA position is its bundle's
            if KEY_RE.match(gk):
                if gk not in st:
                    refused.append('%s (QA gate: %s not found in Jira)' % (eid, gk))
                    continue
                v = gate_verdict(jira, wf, gk, st[gk])
                if v == 'rejected':
                    demote(root, p, eid, st[gk])
                    refused.append('%s (Jira %s moved back to "%s"; set back to in-progress)' % (eid, gk, st[gk][0]))
                    continue
                if v == 'waiting':
                    waiting.append('%s %s "%s"' % (eid, gk, st[gk][0]))
                    continue
        section = o.get('section') or ('Fixed' if tf.kind == 'bug' else 'Added')
        if section not in CL_SECTIONS:
            sys.exit('--section must be one of %s' % ', '.join(CL_SECTIONS))
        changelog_insert(os.path.join(os.path.dirname(p), 'CHANGELOG.md'), changelog_line(e), section, eid)
        tf.remove(eid)
        tf.save()
        done.append('%s -> %s/CHANGELOG.md %s' % (eid, rel_or_abs(os.path.dirname(p), root), section))
        if KEY_RE.match(key):
            keys.append(key)
        if KEY_RE.match(e.value('Bundle') or ''):
            bundles.add(e.value('Bundle'))
    for d in done:
        print('migrated ' + d)
    for r in refused:
        print('refused ' + r)
    for w in waiting:
        print('waiting on QA (gate: %s): %s' % (' / '.join(wf['gate']), w))
    if o.get('skip-gate') and wf['gate'] and done:
        print('note: migrated without the QA gate (--skip-gate)')
    if jira and keys:
        print('Jira -> %s:' % wf['done'])
        bad = sum(0 if jira_move(jira, k, wf['done'], wf) else 1 for k in keys)
        if bad:
            print('%d issue(s) not moved; `trackers.py jira done` retries' % bad)
    if jira:
        for b in sorted(bundles):
            if not bundle_follow(root, jira, wf, b):
                print('bundle %s not moved; `trackers.py bundle sync %s` retries' % (b, b))
    return 1 if refused and not done else 0


def cmd_close(argv):
    """close ID --reason R [--force] [--tracker P | --app A] [--no-jira]"""
    o, pos = opts(argv, flags=('force', 'no-jira'))
    if not pos or o.get('reason') not in CLOSE_REASONS:
        sys.exit('usage: close ID --reason %s [--force]' % '|'.join(CLOSE_REASONS))
    root = repo_root()
    tf, e = locate(root, pos[0], o.get('tracker'), o.get('app'))
    key = e.value('Jira') or ''
    if jira_mode(root) == 'enforce' and not KEY_RE.match(key) and not o.get('force'):
        sys.exit('%s has no Jira key; run `jira sync` first (or --force to drop it with no Jira record)' % e.id)
    tf.remove(e.id)
    tf.save()
    print('closed %s (%s)' % (e.id, o['reason']))
    jira = None if o.get('no-jira') else jira_or_none(root)
    if KEY_RE.match(key):
        wf = fit_workflow(jira, workflow(load_config(root))) if jira else workflow(load_config(root))
        if not jira or not jira_move(jira, key, wf['done'], wf, wf['resolutions'].get(o['reason'])):
            print('resolve %s in Jira as %s' % (key, o['reason']))
        if jira and KEY_RE.match(e.value('Bundle') or ''):
            bundle_follow(root, jira, wf, e.value('Bundle'))
    return 0


LEDGER_SECTIONS = ('Verified', 'Added', 'Changed', 'Fixed', 'Removed', 'Security')
VERSION_RE = re.compile(r'^v?\d+\.\d+\.\d+$')


def freeze_changelog(text, version, date):
    """TEXT with `## Unreleased` moved into `## [VERSION] - DATE` (non-empty sub-sections in ledger
    order) and a fresh, empty `## Unreleased` above it. Earlier sections are untouched. Returns
    (new text, error or None)."""
    lines = text.split('\n')
    try:
        start = next(i for i, l in enumerate(lines) if l.strip() == '## Unreleased')
    except StopIteration:
        return text, 'no `## Unreleased` section'
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith('## ')), len(lines))
    sections, cur, extra = {}, None, []
    for l in lines[start + 1:end]:
        m = re.match(r'^###\s+(\w+)', l)
        if m:
            cur = m.group(1)
            sections.setdefault(cur, [])
        elif l.strip():
            (sections[cur] if cur else extra).append(l)
    if extra:
        return text, 'text under `## Unreleased` outside a ### section: %s' % extra[0][:60]
    unknown = [s for s in sections if s not in LEDGER_SECTIONS and sections[s]]
    if unknown:
        return text, 'unknown section(s) under Unreleased: %s' % ', '.join(unknown)
    if not any(sections.get(s) for s in LEDGER_SECTIONS[1:]):
        return text, 'nothing to release: Added, Changed, Fixed, Removed and Security are empty'
    fresh = ['## Unreleased', ''] + [x for s in LEDGER_SECTIONS for x in ('### ' + s, '')]
    frozen = ['## [%s] - %s' % (version, date), '']
    for s in LEDGER_SECTIONS:
        if sections.get(s):
            frozen += ['### ' + s, ''] + sections[s] + ['']
    return '\n'.join(lines[:start] + fresh + frozen + lines[end:]), None


def cmd_freeze(argv):
    """freeze vX.Y.Z [--date YYYY-MM-DD] [--dry-run] [--changelog P]: /release Stage 2."""
    o, pos = opts(argv, flags=('dry-run',))
    if not pos or not VERSION_RE.match(pos[0]):
        sys.exit('usage: freeze vX.Y.Z [--date YYYY-MM-DD] [--dry-run] [--changelog CHANGELOG.md]')
    version = pos[0]
    path = o.get('changelog') or os.path.join(repo_root(), 'CHANGELOG.md')
    text = read(path)
    if re.search(r'^## \[%s\]' % re.escape(version), text, re.M):
        print('%s is already frozen in %s; nothing to do' % (version, os.path.basename(path)))
        return 0
    date = o.get('date') or time.strftime('%Y-%m-%d')
    crlf = '\r\n' in text
    new, err = freeze_changelog(text.replace('\r\n', '\n'), version, date)
    if crlf:
        new = new.replace('\n', '\r\n')
    if err:
        sys.exit('freeze: %s' % err)
    if o.get('dry-run'):
        import difflib
        sys.stdout.writelines(difflib.unified_diff(text.splitlines(True), new.splitlines(True), path, path))
        return 0
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(new)
    print('froze Unreleased into [%s] - %s' % (version, date))
    return 0


def cmd_show(argv):
    """show ID [--app A]"""
    o, pos = opts(argv)
    if not pos:
        sys.exit('usage: show ID')
    eid, root = pos[0], repo_root()
    cfg = load_config(root)
    hits = [p for p in tracker_files(root) if ('### [%s]' % eid) in read(p)]
    if o.get('app'):
        hits = [p for p in hits if app_of(root, p, cfg) == o['app']]
    for p in hits:
        print('# %s (current)\n' % rel_or_abs(p, root))
        print(TrackerFile(p).get(eid).render())
    if hits:
        return 0
    revs = git('log', '--format=%H', '-S', '### [%s]' % eid, '--', '*bugs.md', '*features.md', cwd=root) or ''
    for rev in revs.split():
        for ref in (rev, rev + '^'):
            files = git('diff-tree', '--no-commit-id', '--name-only', '-r', rev, cwd=root) or ''
            for f in files.split():
                if os.path.basename(f) not in TRACKER_FILES:
                    continue
                blob = git('show', '%s:%s' % (ref, f), cwd=root)
                if not blob or ('### [%s]' % eid) not in blob:
                    continue
                part = re.split(r'(?m)^(?=### \[)', blob)
                for chunk in part:
                    if chunk.startswith('### [%s]' % eid):
                        chunk = re.split(r'(?m)^## ', chunk)[0]
                        print('# %s at %s (removed later; see CHANGELOG.md / Jira)\n' % (f, ref[:10]))
                        print(chunk.rstrip() + '\n')
                        return 0
    sys.exit('%s: not in any tracker or its history' % eid)


# ---------------------------------------------------------------- export

TICKET_ID_RE = re.compile(r'\b(?:BUG|FEAT)-\d+\b')
# Requirement ids as the spec skill's req_index.py parses them, plus brief capability ids.
REQ_ID_RE = re.compile(r'\b(?:(?:[A-Z][A-Z0-9]{0,7}-)?(?:FR|NFR|IR|CON)(?:-[A-Z]{2,8})?-\d{1,4}[a-z]?|CAP-\d+)\b')


def entry_record(root, p, e, cfg):
    """One entry as plain data for planning tools (`export --json`)."""
    def items(name):
        return [x.strip() for x in re.split(r'[,\n]', e.text(name) or '') if x.strip() and x.strip() != 'unknown']
    ac = e.text('Acceptance criteria') or ''
    return {'id': e.id, 'kind': kind_of(p), 'title': e.title, 'tracker': rel_or_abs(p, root).replace('\\', '/'),
            'app': app_of(root, p, cfg), 'status': e.status(),
            'priority': e.value('Priority') or e.value('Severity') or '',
            'area': items('Area'), 'files': items('File(s)'),
            'depends': sorted(set(TICKET_ID_RE.findall(e.text('Depends on') or '')) - {e.id}),
            'target': e.value('Target') or '', 'jira': e.value('Jira') or '',
            'req': sorted(set(REQ_ID_RE.findall(e.text('Req') or ''))),
            'criteria': len([l for l in ac.splitlines() if l.strip().startswith('- ')]) or (1 if ac.strip() else 0)}


def ledger_records(root):
    """Every ledger line in any CHANGELOG.md next to a tracker: id, Req ids, release section."""
    paths = {os.path.join(os.path.dirname(p), 'CHANGELOG.md') for p in tracker_files(root)}
    paths.add(os.path.join(root, 'CHANGELOG.md'))
    out = []
    for cl in sorted(paths):
        if not os.path.exists(cl):
            continue
        version = 'Unreleased'
        for line in read(cl).splitlines():
            h = re.match(r'^## \[?([^\]\s]+)\]?', line)
            if h:
                version = h.group(1)
                continue
            m = re.match(r'^- \[((?:BUG|FEAT)-\d+)\](.*)$', line)
            if m:
                req = re.search(r'\(Req:([^)]*)\)', m.group(2))
                out.append({'id': m.group(1), 'req': sorted(set(REQ_ID_RE.findall(req.group(1)))) if req else [],
                            'version': version})
    return out


def shipped_ids(root):
    """Ticket ids that have a ledger line in any CHANGELOG.md next to a tracker."""
    return sorted({r['id'] for r in ledger_records(root)})


def cmd_export(argv):
    """export [--status open|todo|in-progress|pending|all] [--type bug|feature] [--area A] [--app A]
              [--ids I,J] [--no-key] [-o FILE | --json]"""
    o, _ = opts(argv, flags=('no-key', 'json'))
    root = repo_root()
    cfg = load_config(root)
    want = o.get('status', 'open')
    ids = set(x.strip() for x in o.get('ids', '').split(',') if x.strip())
    groups, n = [], {'bug': 0, 'feature': 0}
    for p in tracker_files(root):
        kind = kind_of(p)
        if o.get('type') and o['type'] != kind:
            continue
        if o.get('app') and app_of(root, p, cfg) != o['app']:
            continue
        sel = []
        for e in TrackerFile(p).entries:
            st = e.status()
            if ids and e.id not in ids:
                continue
            if not ids:
                if want == 'todo' and st != 'open':
                    continue
                if want == 'in-progress' and st != 'in-progress':
                    continue
                if want == 'pending' and not st.endswith('pending-migration'):
                    continue
                if want == 'open' and st.endswith('pending-migration'):
                    continue
            if o.get('area') and o['area'] not in [a.strip() for a in (e.value('Area') or '').split(',')]:
                continue
            if o.get('no-key') and KEY_RE.match(e.value('Jira') or ''):
                continue
            sel.append(e)
        if sel:
            groups.append((p, sel))
            n[kind] += len(sel)
    if o.get('json'):
        recs = [entry_record(root, p, e, cfg) for p, sel in groups for e in sel]
        ledger = ledger_records(root)
        print(json.dumps({'entries': recs, 'shipped': sorted({r['id'] for r in ledger}), 'ledger': ledger}, indent=1))
        return 0
    desc = ', '.join('%s=%s' % (k, v) for k, v in sorted(o.items()) if k != 'out') or 'status=open'
    out = ['# Jira export: %s' % desc, '',
           'Generated %s. Edit freely, then create the issues with:' % today(), '',
           '    python .cycle/trackers.py jira push <this file>', '',
           'Totals: %d stories (features) + %d bugs = %d issues.' % (n['feature'], n['bug'], n['feature'] + n['bug']), '']
    for p, sel in groups:
        out += ['## %s' % rel_or_abs(p, root).replace('\\', '/'), '']
        out += [e.render() for e in sel]
    text = '\n'.join(out).rstrip('\n') + '\n'
    dest = o.get('out') or 'jira-export-%s.md' % today()
    write(dest, text)
    print('wrote %s (%d stories + %d bugs)' % (dest, n['feature'], n['bug']))
    return 0


def parse_export(path):
    """Yield (tracker_rel, Entry) from an export file."""
    text = read(path)
    res, cur = [], None
    for chunk in re.split(r'(?m)^(?=## |### \[)', text):
        if chunk.startswith('## '):
            cur = chunk[3:].split('\n')[0].strip()
        elif chunk.startswith('### [') and cur:
            res.append((cur, parse_entry(re.split(r'(?m)^## ', chunk)[0])))
    return res


# ---------------------------------------------------------------- Jira

class JiraError(Exception):
    def __init__(self, code, body):
        Exception.__init__(self, 'HTTP %s: %s' % (code, body))
        self.code, self.body = code, body


class Jira:
    def __init__(self, cfg):
        j = cfg.get('jira', {})
        self.cfg = j
        # Every value comes from this repo's .cycle/tracker.json, so each project can point
        # at its own Jira (any Cloud site or a Data Center server). The JIRA_SITE /
        # JIRA_PROJECT variables only fill a value the config leaves out.
        self.site = (j.get('site') or os.environ.get('JIRA_SITE') or '').rstrip('/')
        if self.site and not self.site.startswith('http'):
            self.site = 'https://' + self.site
        self.project = j.get('project') or os.environ.get('JIRA_PROJECT', '')
        a = j.get('auth') or {}
        self.auth_type = a.get('type', 'basic')            # basic: Cloud email + API token; bearer: Data Center PAT
        # Several Jira accounts on one machine: the repo may name its variables; otherwise a
        # site-specific pair (JIRA_EMAIL_<SITE>, JIRA_API_TOKEN_<SITE>, SITE = first label of the
        # host, e.g. PARADIGMTEST_DEV1) wins over the plain JIRA_EMAIL / JIRA_API_TOKEN.
        host = urllib.parse.urlparse(self.site).hostname or ''
        self.site_tag = re.sub(r'[^A-Z0-9]+', '_', host.split('.')[0].upper()).strip('_')
        self.email_env = self._pick(a.get('emailEnv'), 'JIRA_EMAIL')
        self.token_env = self._pick(a.get('tokenEnv'), 'JIRA_API_TOKEN')
        self.email = os.environ.get(self.email_env, '')
        self.token = os.environ.get(self.token_env, '')

    def _pick(self, named, base):
        if named:
            return named
        tagged = '%s_%s' % (base, self.site_tag) if self.site_tag else None
        return tagged if tagged and os.environ.get(tagged) else base

    def missing(self):
        need = [(self.token_env, self.token), ('jira.site', self.site), ('jira.project', self.project)]
        if self.auth_type == 'basic':
            need.insert(0, (self.email_env, self.email))
        return [n for n, v in need if not v]

    def req(self, method, path, body=None):
        if self.auth_type == 'bearer':
            header = 'Bearer ' + self.token
        else:
            header = 'Basic ' + base64.b64encode(('%s:%s' % (self.email, self.token)).encode()).decode()
        data = json.dumps(body).encode() if body is not None else None
        for attempt in range(4):
            r = urllib.request.Request(self.site + path, data=data, method=method, headers={
                'Authorization': header, 'Accept': 'application/json',
                'Content-Type': 'application/json'})
            try:
                # self.site is always http(s): __init__ gives a bare host https://.
                with urllib.request.urlopen(r, timeout=60) as resp:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
                    raw = resp.read()
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as e:
                if e.code == 429 and attempt < 3:
                    time.sleep(float(e.headers.get('Retry-After') or 2 ** attempt))
                    continue
                raise JiraError(e.code, e.read().decode('utf-8', errors='replace')[:800])

    def search(self, jql, fields, limit):
        """JQL search: Cloud's /rest/api/3/search/jql, falling back to v2 /search (Data Center)."""
        body = {'jql': jql, 'fields': fields, 'maxResults': limit}
        try:
            return self.req('POST', '/rest/api/3/search/jql', body)
        except JiraError as e:
            if e.code not in (404, 405, 410):
                raise
            return self.req('POST', '/rest/api/2/search', body)

    def field_id(self, name):
        return (self.cfg.get('fields') or {}).get(name)

    def find_existing(self, ext_id, labels):
        fid = self.field_id('externalId')
        if fid:
            num = fid.replace('customfield_', '')
            jql = 'project = "%s" AND cf[%s] ~ "\\"%s\\""' % (self.project, num, ext_id)
            res = self.search(jql, [fid], 20)
            for iss in res.get('issues', []):
                if str((iss.get('fields') or {}).get(fid) or '').strip() == ext_id:
                    return iss['key']
            return None
        jql = 'project = "%s" AND %s' % (self.project, ' AND '.join('labels = "%s"' % l for l in labels))
        res = self.search(jql, ['summary'], 2)
        iss = res.get('issues', [])
        return iss[0]['key'] if len(iss) == 1 else None

    def meta(self, kind):
        """The project's create screen for this issue type: {field id: {name, required, schema,
        allowed}}. Project-scoped, so same-named fields elsewhere on the site never confuse it."""
        self._meta = getattr(self, '_meta', {})
        if kind in self._meta:
            return self._meta[kind]
        want = self.issue_type(kind)
        out = {}
        try:
            proj = urllib.parse.quote(self.project)
            r = self.req('GET', '/rest/api/2/issue/createmeta/%s/issuetypes?maxResults=200' % proj)
            types = r.get('issueTypes') or r.get('values') or []
            t = next((x for x in types if x.get('name', '').lower() == want.lower()), None)
            if t:
                start = 0
                while True:
                    r = self.req('GET', '/rest/api/2/issue/createmeta/%s/issuetypes/%s?maxResults=200&startAt=%d'
                                 % (proj, t['id'], start))
                    rows = r.get('fields') or r.get('values') or []
                    for f in rows:
                        out[f.get('fieldId') or f.get('key')] = f
                    start += len(rows)
                    if not rows or start >= r.get('total', start):
                        break
        except JiraError as e:
            if e.code not in (404, 405):
                raise
            r = self.req('GET', '/rest/api/2/issue/createmeta?projectKeys=%s&issuetypeNames=%s'
                         '&expand=projects.issuetypes.fields' % (urllib.parse.quote(self.project),
                                                                urllib.parse.quote(want)))
            for pr in r.get('projects', []):
                for it in pr.get('issuetypes', []):
                    for fid, f in (it.get('fields') or {}).items():
                        out[fid] = dict(f, fieldId=fid)
        self._meta[kind] = {fid: {'name': f.get('name', fid), 'required': bool(f.get('required')),
                                  'schema': f.get('schema') or {},
                                  'allowed': [v.get('value') or v.get('name') for v in f.get('allowedValues') or []
                                              if isinstance(v, dict)]}
                            for fid, f in out.items() if fid}
        return self._meta[kind]

    def issue_type(self, kind):
        return dict(ISSUE_TYPES, **(self.cfg.get('issueTypes') or {}))[kind]

    # ------------------------------------------------------------ issue links (bundles)

    def link_type(self):
        return (self.cfg.get('bundles') or {}).get('link') or 'Implements'

    def links_of(self, key):
        """[(link id, type name, side, other key)]: side 'outward' = KEY <outward> other."""
        r = self.req('GET', '/rest/api/2/issue/%s?fields=issuelinks' % urllib.parse.quote(key))
        out = []
        for l in (r.get('fields') or {}).get('issuelinks') or []:
            side = 'outward' if 'outwardIssue' in l else 'inward'
            out.append((l.get('id'), (l.get('type') or {}).get('name', ''), side,
                        (l.get('outwardIssue') or l.get('inwardIssue') or {}).get('key')))
        return out

    def _post_link(self, src, dst, swapped):
        out, inw = (dst, src) if swapped else (src, dst)
        self.req('POST', '/rest/api/2/issueLink', {'type': {'name': self.link_type()},
                                                   'outwardIssue': {'key': out}, 'inwardIssue': {'key': inw}})

    def link(self, src, dst):
        """SRC <outward> DST (the bundle implements the member). Which body side is which is easy
        to get backwards, so the first link of a run is checked on DST and redone if reversed."""
        name = self.link_type().lower()
        side = lambda: next((s for _, t, s, k in self.links_of(dst) if t.lower() == name and k == src), None)
        if side() == 'inward':
            return 'already linked'
        first = getattr(self, '_swap', None)
        self._post_link(src, dst, bool(first))
        if first is None:
            self._swap = False
            if side() == 'outward':
                self.unlink(dst, src)
                self._post_link(src, dst, True)
                self._swap = True
        return 'linked'

    def unlink(self, a, b):
        """Delete every link of the bundle type between A and B; returns how many."""
        name = self.link_type().lower()
        ids = [i for i, t, _, k in self.links_of(a) if t.lower() == name and k == b]
        for i in ids:
            self.req('DELETE', '/rest/api/2/issueLink/%s' % i)
        return len(ids)

    def epics(self, full=False):
        """Open epics of the project: [(key, summary)]; FULL adds the description: [(key, summary, description)]."""
        jql = ('project = "%s" AND issuetype = "%s" AND statusCategory != Done ORDER BY key'
               % (self.project, self.issue_type('epic')))
        res = self.search_all(jql, ['summary', 'description'] if full else ['summary'], 1000)
        if full:
            return [(i['key'], (i.get('fields') or {}).get('summary', ''), plain_text((i.get('fields') or {}).get('description')))
                    for i in res]
        return [(i['key'], (i.get('fields') or {}).get('summary', '')) for i in res]

    def epic_for(self, e, app):
        """The entry's epic: its `Jira parent:`, else the first jira.epics.rules match, else default."""
        own = e.value('Jira parent') or ''
        if KEY_RE.match(own):
            return own, 'entry'
        cfg = self.cfg.get('epics') or {}
        areas = [a.strip().lower() for a in (e.value('Area') or '').split(',')]
        req = e.value('Req') or ''
        for r in cfg.get('rules') or []:
            m = r.get('match') or {}
            if 'app' in m and m['app'] != app:
                continue
            if 'area' in m and m['area'].lower() not in areas:
                continue
            if 'req' in m and not re.search(r'\b%s' % re.escape(m['req']), req):
                continue
            if 'title' in m and not re.search(m['title'], e.title, re.I):
                continue
            if 'kind' in m and m['kind'] != ('bug' if e.id.startswith('BUG') else 'feature'):
                continue
            return r['epic'], 'rule'
        if cfg.get('default'):
            return cfg['default'], 'default'
        return None, None

    def set_parent(self, key, epic):
        fld = (self.cfg.get('epics') or {}).get('field', 'parent')
        val = {'key': epic} if fld == 'parent' else epic
        self.req('PUT', '/rest/api/2/issue/%s' % urllib.parse.quote(key), {'fields': {fld: val}})

    def parent_of(self, key):
        fld = (self.cfg.get('epics') or {}).get('field', 'parent')
        r = self.req('GET', '/rest/api/2/issue/%s?fields=%s' % (urllib.parse.quote(key), fld))
        v = (r.get('fields') or {}).get(fld)
        return (v or {}).get('key') if isinstance(v, dict) else v

    def field_map(self, kind):
        """jira.fields.map.<kind>: {field id: source}; acceptanceCriteria/testPlan keys still honoured."""
        fields = self.cfg.get('fields') or {}
        m = dict((fields.get('map') or {}).get(kind) or {})
        if kind == 'feature':
            for key, src in (('acceptanceCriteria', 'Acceptance criteria'), ('testPlan', 'Test plan')):
                if fields.get(key) and fields[key] not in m:
                    m[fields[key]] = src
        return m

    def create(self, fields):
        optional = ['parent', 'components', 'priority']
        tried = set()
        while True:
            try:
                return self.req('POST', '/rest/api/2/issue', {'fields': fields})['key']
            except JiraError as e:
                if e.code != 400:
                    raise
                try:
                    errs = (json.loads(e.body).get('errors') or {})
                except ValueError:
                    raise e
                bad = [k for k in errs if k in optional and k in fields and k not in tried]
                if not bad:
                    raise
                for k in bad:
                    tried.add(k)
                    fields.pop(k)
                    sys.stderr.write('jira: retrying without %s (%s)\n' % (k, errs[k]))

    # ------------------------------------------------------------ workflow (status moves)

    def project_statuses(self):
        """{status name lower: (name, category key)} across the project's issue types (cached)."""
        if getattr(self, '_st', None) is None:
            self._st = {}
            for it in self.req('GET', '/rest/api/2/project/%s/statuses' % urllib.parse.quote(self.project)) or []:
                for s in it.get('statuses', []):
                    self._st[s['name'].lower()] = (s['name'], (s.get('statusCategory') or {}).get('key', 'indeterminate'))
        return self._st

    def status(self, key):
        s = self.req('GET', '/rest/api/2/issue/%s?fields=status' % key)['fields']['status']
        return s['name'], s['statusCategory']['key']

    def myself(self):
        """(assign body, display name) for the token's user: accountId on Cloud, name on Data Center."""
        if getattr(self, '_me', None) is None:
            u = self.req('GET', '/rest/api/2/myself')
            ref = {'accountId': u['accountId']} if u.get('accountId') else {'name': u['name']}
            self._me = (ref, u.get('displayName') or u.get('name') or u.get('accountId'))
        return self._me

    def assignee(self, key):
        return (self.req('GET', '/rest/api/2/issue/%s?fields=assignee' % key).get('fields') or {}).get('assignee')

    def assign(self, key, ref):
        self.req('PUT', '/rest/api/2/issue/%s/assignee' % key, ref)

    def statuses(self, keys):
        """{key: (status, category)}; one search per 50 keys, one GET per key if a search is refused."""
        out = {}
        keys = sorted(set(keys))
        for i in range(0, len(keys), 50):
            chunk = keys[i:i + 50]
            try:
                res = self.search('key in (%s)' % ','.join(chunk), ['status'], len(chunk))
                for iss in res.get('issues', []):
                    s = iss['fields']['status']
                    out[iss['key']] = (s['name'], s['statusCategory']['key'])
            except JiraError:
                for k in chunk:
                    try:
                        out[k] = self.status(k)
                    except JiraError:
                        pass  # deleted or moved issue: reported as not found
        return out

    def rank(self, name, cat, wf):
        """Position on the board: category first (new < indeterminate < done), then workflow.order."""
        order = [s.lower() for s in wf.get('order') or []]
        r = CAT_RANK.get(cat, 1) * 1000
        return r + (order.index(name.lower()) + 1 if name.lower() in order else 500)

    def target_rank(self, target, wf):
        if target in CAT_RANK:
            return CAT_RANK[target] * 1000 + (0 if target != 'done' else 1)
        name, cat = self.project_statuses().get(target.lower(), (target, 'indeterminate'))
        return self.rank(name, cat, wf)

    def move(self, key, target, wf, resolution=None):
        """Move KEY forward to TARGET (a status name, or a category: 'indeterminate', 'done').
        Never moves an issue backwards. Returns (result, status): moved | already | ahead."""
        hit = (lambda n, c: c == target) if target in CAT_RANK else (lambda n, c: n.lower() == target.lower())
        goal = self.target_rank(target, wf)
        name, cat = self.status(key)
        start = name
        for hop in range(9):
            if hit(name, cat):
                return ('already' if hop == 0 else 'moved'), name
            cur = self.rank(name, cat, wf)
            if cur >= goal and target not in CAT_RANK:
                return 'ahead', name
            if cat == 'done':
                return 'ahead', name
            ts = self.req('GET', '/rest/api/2/issue/%s/transitions?expand=transitions.fields' % key).get('transitions', [])
            def dest(t):
                to = t.get('to') or {}
                return to.get('name', ''), (to.get('statusCategory') or {}).get('key', 'indeterminate')
            direct = [t for t in ts if hit(*dest(t))]
            if direct and target == 'done':  # prefer a status literally named Done / Complete / Resolved / Closed
                direct.sort(key=lambda t: next((i for i, w in enumerate(DONE_NAMES) if w == dest(t)[0].lower()), 9))
            fwd = [t for t in ts if cur < self.rank(*dest(t), wf) < goal and dest(t)[1] != 'done']
            pick = direct[0] if direct else (max(fwd, key=lambda t: self.rank(*dest(t), wf)) if fwd else None)
            if not pick:
                raise JiraError('no-path', 'no transition from "%s" toward "%s" (available: %s)' % (
                    name, target, ', '.join(dest(t)[0] for t in ts) or 'none'))
            body = {'transition': {'id': pick['id']}}
            rf = (pick.get('fields') or {}).get('resolution')
            if rf and (resolution or rf.get('required')):
                allowed = [v.get('name', '') for v in rf.get('allowedValues') or []]
                want = next((a for a in allowed if a.lower() == (resolution or '').lower()), None) or \
                    next((a for a in allowed if a.lower() == 'done'), None) or (allowed[0] if allowed else None)
                if want:
                    body['fields'] = {'resolution': {'name': want}}
            self.req('POST', '/rest/api/2/issue/%s/transitions' % key, body)
            name, cat = dest(pick)
        raise JiraError('no-path', 'gave up after 8 moves from "%s" toward "%s"' % (start, target))

    def versions(self):
        return self.req('GET', '/rest/api/2/project/%s/versions' % urllib.parse.quote(self.project)) or []

    def version(self, name):
        return next((v for v in self.versions() if v.get('name') == name), None)

    def create_version(self, name, description=None, released=False, date=None):
        proj = self.req('GET', '/rest/api/2/project/%s' % urllib.parse.quote(self.project))
        body = {'name': name, 'projectId': int(proj['id'])}
        if description:
            body['description'] = description
        if released:
            body.update(released=True, releaseDate=date or today())
        return self.req('POST', '/rest/api/2/version', body)

    def update_version(self, vid, fields):
        return self.req('PUT', '/rest/api/2/version/%s' % vid, fields)

    def set_target(self, key, version):
        """Set semantics for the planned version: unreleased fix versions become [VERSION] (none when
        None); released ones are kept. Returns 'already' or 'set'."""
        cur = ((self.req('GET', '/rest/api/2/issue/%s?fields=fixVersions' % key) or {}).get('fields') or {}).get('fixVersions') or []
        want = [v['name'] for v in cur if v.get('released')] + ([version] if version else [])
        if sorted(want) == sorted(v['name'] for v in cur):
            return 'already'
        self.req('PUT', '/rest/api/2/issue/%s' % key, {'fields': {'fixVersions': [{'name': n} for n in want]}})
        return 'set'

    def search_all(self, jql, fields, cap=5000):
        """Every match (paged): Cloud /rest/api/3/search/jql tokens, else v2 /search startAt."""
        out, token, start, v2 = [], None, 0, False
        while len(out) < cap:
            body = {'jql': jql, 'fields': fields, 'maxResults': 100}
            if v2:
                body['startAt'] = start
            elif token:
                body['nextPageToken'] = token
            try:
                res = self.req('POST', '/rest/api/2/search' if v2 else '/rest/api/3/search/jql', body) or {}
            except JiraError as e:
                if v2 or e.code not in (404, 405, 410):
                    raise
                v2 = True
                continue
            iss = res.get('issues', [])
            out += iss
            if v2:
                start += len(iss)
                if not iss or start >= res.get('total', 0):
                    break
            else:
                token = res.get('nextPageToken')
                if not token or res.get('isLast'):
                    break
        return out

    def add_fix_version(self, keys, version):
        proj = self.req('GET', '/rest/api/2/project/%s' % urllib.parse.quote(self.project))
        names = [v.get('name') for v in self.req('GET', '/rest/api/2/project/%s/versions' % urllib.parse.quote(self.project)) or []]
        if version not in names:
            self.req('POST', '/rest/api/2/version', {'name': version, 'projectId': int(proj['id'])})
        done = []
        for k in keys:
            self.req('PUT', '/rest/api/2/issue/%s' % k, {'update': {'fixVersions': [{'add': {'name': version}}]}})
            done.append(k)
        return done


# ---------------------------------------------------------------- Jira workflow: tracker -> board

CAT_RANK = {'new': 0, 'indeterminate': 1, 'done': 2}
NET_ERRORS = (JiraError, OSError, http.client.HTTPException, ValueError, KeyError)  # OSError covers URLError
DONE_NAMES = ('done', 'complete', 'completed', 'resolved', 'closed')
RESOLUTIONS = {'duplicate': 'Duplicate', 'wontfix': "Won't Do", 'superseded': "Won't Do",
               'cannot-reproduce': 'Cannot Reproduce', 'not-a-defect': "Won't Do"}
CL_KEY = re.compile(r'^[-*] \[(?:BUG|FEAT)-\d+[a-z]*\] ([A-Z][A-Z0-9]+-\d+) ')


def workflow(cfg):
    """jira.workflow: inProgress / review / gate / done / order / resolutions (TRACKERS-jira.md, "Jira workflow")."""
    w = dict((cfg.get('jira') or {}).get('workflow') or {})
    w['inProgress'] = w.get('inProgress') or 'indeterminate'
    w['review'] = w.get('review') or None
    g = w.get('gate') or []
    w['gate'] = [g] if isinstance(g, str) else list(g)
    w['done'] = w.get('done') or 'done'
    w['order'] = w.get('order') or []
    w['resolutions'] = dict(RESOLUTIONS, **(w.get('resolutions') or {}))
    return w


def fit_workflow(jira, wf):
    """Drop configured statuses this project does not have, so one mapping works on any board:
    no review status = no review move, no gate status = no gate, no inProgress/done = the category."""
    try:
        have = jira.project_statuses()
    except NET_ERRORS:
        return wf
    w, gone = dict(wf), []
    for k, fallback in (('inProgress', 'indeterminate'), ('done', 'done'), ('review', None)):
        if w[k] and w[k] not in CAT_RANK and w[k].lower() not in have:
            gone.append(w[k])
            w[k] = fallback
    w['gate'] = [g for g in wf['gate'] if g.lower() in have or gone.append(g)]
    w['order'] = [x for x in wf['order'] if x.lower() in have]
    if gone and not getattr(jira, '_warned', False):
        jira._warned = True
        print('note: %s has no status %s; skipped (TRACKERS-jira.md, "Jira workflow")' % (
            jira.project, ', '.join('"%s"' % g for g in gone)))
    return w


def jira_or_none(root):
    if jira_mode(root) == 'off':
        return None
    j = Jira(load_config(root))
    return None if j.missing() else j


def status_target(status, wf):
    if status == 'in-progress':
        return wf['inProgress']
    if status.endswith('pending-migration'):
        return wf['review']
    return None


def jira_move(jira, key, target, wf, resolution=None):
    """Move one issue; print the outcome; never raise. Returns True when the board matches."""
    try:
        res, st = jira.move(key, target, wf, resolution)
        print('  %s: %s' % (key, {'moved': 'moved to %s' % st, 'already': 'already %s' % st,
                                  'ahead': 'left at %s (already past %s)' % (st, target)}[res]))
        return True
    except NET_ERRORS as ex:
        print('  warning: %s not moved to %s: %s' % (key, target, ex))
        return False


def jira_claim(jira, key, force=False):
    """Assign KEY to the token's user; an issue someone else holds is left unless FORCE.
    Prints the outcome; never raises. Returns the holder's display name afterwards, None on error."""
    try:
        ref, me = jira.myself()
        cur = jira.assignee(key)
        if cur and all(cur.get(k) == v for k, v in ref.items()):
            print('  %s: already assigned to %s' % (key, me))
            return me
        if cur and not force:
            other = cur.get('displayName') or cur.get('name') or '?'
            print('  %s: left assigned to %s (`set <ID> Assignee me` takes it)' % (key, other))
            return other
        jira.assign(key, ref)
        print('  %s: assigned to %s' % (key, me))
        return me
    except NET_ERRORS as ex:
        print('  warning: %s not assigned: %s' % (key, ex))
        return None


def gate_verdict(jira, wf, key, st):
    """For a pending entry: ready | waiting | rejected (Jira moved back before review)."""
    name, cat = st
    if cat == 'done' or name.lower() in [g.lower() for g in wf['gate']]:
        return 'ready'
    if not wf['gate'] and not wf['review']:
        return 'ready'
    back = wf['review'] or wf['inProgress']
    if back in CAT_RANK:
        rejected = CAT_RANK[cat] < CAT_RANK[back] or (back == 'indeterminate' and cat == 'new')
    else:
        rejected = jira.rank(name, cat, wf) < jira.target_rank(back, wf)
    return 'rejected' if rejected else ('waiting' if wf['gate'] else 'ready')


def gate_key(e):
    """The issue whose board position gates an entry: its bundle's, else its own."""
    b = e.value('Bundle') or ''
    return b if KEY_RE.match(b) else (e.value('Jira') or '')


def demote(root, path, eid, st):
    tf = TrackerFile(path)
    e = tf.get(eid)
    e.set(tf.kind, 'Status', 'in-progress')
    e.box = ' '
    f = e.find('Log')
    lines = (f[1] if f else ['']) + ['  - %s Jira: moved back to "%s"; set back to in-progress' % (today(), st[0])]
    e.set(tf.kind, 'Log', '')
    e.find('Log')[1] = lines
    fix_entry(e, tf.kind)
    tf.save()


def pending_entries(root, app=None):
    cfg = load_config(root)
    out = []
    for p in tracker_files(root):
        if app and app_of(root, p, cfg) != app:
            continue
        for e in TrackerFile(p).entries:
            if e.status().endswith('pending-migration'):
                out.append((p, e))
    return out


def jira_status(root, o):
    """jira status [--apply] [--app A]: pending entries vs the board; --apply demotes rejected ones."""
    jira = jira_or_none(root)
    if not jira:
        sys.exit('jira status: Jira is off or credentials are missing (jira doctor)')
    wf = fit_workflow(jira, workflow(load_config(root)))
    pend = pending_entries(root, o.get('app'))
    keys = [gate_key(e) for _, e in pend if KEY_RE.match(gate_key(e))]
    try:
        st = jira.statuses(keys)
    except NET_ERRORS as ex:
        sys.exit('jira status: %s' % ex)
    counts = {}
    for p, e in pend:
        k = gate_key(e)
        if k not in st:
            v, shown = 'no-issue', k or 'pending'
        else:
            v, shown = gate_verdict(jira, wf, k, st[k]), '%s "%s"%s' % (
                k, st[k][0], ' (bundle of %s)' % e.value('Jira') if k != e.value('Jira') else '')
        counts[v] = counts.get(v, 0) + 1
        print('%-9s %-18s %s' % (v, e.id, shown))
        if v == 'rejected' and o.get('apply'):
            demote(root, p, e.id, st[k])
            print('          -> set back to in-progress')
    print('jira status: %s%s' % (', '.join('%d %s' % (n, v) for v, n in sorted(counts.items())) or 'nothing pending',
                                 '' if o.get('apply') or not counts.get('rejected') else '; --apply sets rejected entries back to in-progress'))
    return 0


def changelog_keys(root, section=None):
    """Jira keys on ledger lines; SECTION limits to one '## <version>' block (e.g. v1.4.0 or Unreleased)."""
    paths = {os.path.join(os.path.dirname(p), 'CHANGELOG.md') for p in tracker_files(root)}
    paths.add(os.path.join(root, 'CHANGELOG.md'))
    keys = []
    for p in sorted(paths):
        if not os.path.exists(p):
            continue
        cur = None
        for line in read(p).split('\n'):
            if line.startswith('## '):
                cur = line[3:].strip().strip('[]').split(']')[0].split(' ')[0]
                continue
            m = CL_KEY.match(line)
            if m and (section is None or (cur or '').lstrip('v') == section.lstrip('v')):
                keys.append(m.group(1))
    return sorted(set(keys))


SECTION_RE = re.compile(r'^## \[?v?(\d+\.\d+\.\d+)\]?(.*)$')


def changelog_sections(paths):
    """{'X.Y.Z': 'YYYY-MM-DD' or ''} for every released '## [v]X.Y.Z' section in these ledgers."""
    out = {}
    for p in paths:
        if os.path.exists(p):
            for line in read(p).split('\n'):
                m = SECTION_RE.match(line)
                if m:
                    d = DATE_RE.search(m.group(2))
                    out.setdefault(m.group(1), d.group(1) if d else '')
    return out


def ledger_paths(root):
    paths = {os.path.join(os.path.dirname(p), 'CHANGELOG.md') for p in tracker_files(root)}
    paths.add(os.path.join(root, 'CHANGELOG.md'))
    return sorted(paths)


def target_of(e):
    """The entry's planned version, 'unscheduled', or None when it carries no Target."""
    t = e.value('Target')
    return t if t and TARGET_RE.match(t) else None


def jira_target(jira, key, target, made=None):
    """Make KEY's planned fix version match TARGET (vX.Y.Z; 'unscheduled' clears it). Released fix
    versions stay. A missing version is created bare (MADE caches names). Prints; never raises."""
    try:
        if target != 'unscheduled' and (made is None or target not in made):
            if not jira.version(target):
                jira.create_version(target)
                print('  created version %s (describe it: `jira version edit %s --description ...`)' % (target, target))
            if made is not None:
                made.add(target)
        res = jira.set_target(key, None if target == 'unscheduled' else target)
        print('  %s: fix version %s%s' % (key, 'already ' if res == 'already' else '', 'cleared' if target == 'unscheduled' else target))
        return True
    except NET_ERRORS as ex:
        print('  warning: %s fix version not set to %s: %s' % (key, target, ex))
        return False


def resolution_for(status, wf):
    """Resolution a removed entry's status implies: a close reason maps through jira.workflow.resolutions;
    fixed / shipped / migrated -> None (the Done transition's default)."""
    s = (status or '').lower()
    if re.search(r"won.?t", s):
        return wf['resolutions'].get('wontfix')
    return next((wf['resolutions'].get(r) for r in CLOSE_REASONS if r in s or r.replace('-', ' ') in s), None)


def done_keys(jira, wf, pairs, dry):
    """Move [(key, tracker status or None)] to Done; prints one summary line plus each move. Returns failures."""
    try:
        st = jira.statuses([k for k, _ in pairs])
    except NET_ERRORS as ex:
        print('  warning: Jira unreachable: %s' % ex)
        return len(pairs)
    todo = [(k, s) for k, s in dict(pairs).items() if k in st and st[k][1] != 'done']
    gone = [k for k, _ in pairs if k not in st]
    print('  %d already done, %d to move%s' % (len(st) - len(todo), len(todo),
                                              ', not found: %s' % ', '.join(gone) if gone else ''))
    bad = 0
    for k, s in todo:
        res = resolution_for(s, wf)
        if dry:
            print('  %s: %s -> %s%s' % (k, st[k][0], wf['done'], ' (%s)' % res if res else ''))
        elif not jira_move(jira, k, wf['done'], wf, res):
            bad += 1
    return bad


def jira_done(root, o, pos=()):
    """jira done [KEY...] [--dry-run]: move to Done every issue on a CHANGELOG ledger line, or the named
    KEYs (issues whose entries left the trackers with no keyed ledger line, e.g. removed by `adopt`)."""
    jira = jira_or_none(root)
    if not jira:
        sys.exit('jira done: Jira is off or credentials are missing (jira doctor)')
    bad = [k for k in pos if not KEY_RE.match(k)]
    if bad:
        sys.exit('jira done: not issue keys: %s' % ', '.join(bad))
    wf = fit_workflow(jira, workflow(load_config(root)))
    keys = list(dict.fromkeys(pos)) or [k for k in changelog_keys(root) if k.startswith(jira.project + '-')]
    print('jira done: %d %s keys%s' % (len(keys), 'named' if pos else 'ledger', ' (dry run)' if o.get('dry-run') else ''))
    return 1 if done_keys(jira, wf, [(k, None) for k in keys], o.get('dry-run')) else 0


def jira_release(root, o, pos):
    """jira release VERSION: set fixVersion VERSION on the issues of that CHANGELOG section."""
    if not pos:
        sys.exit('usage: jira release VERSION   (the CHANGELOG section, e.g. v1.4.0)')
    jira = jira_or_none(root)
    if not jira:
        sys.exit('jira release: Jira is off or credentials are missing (jira doctor)')
    keys = [k for k in changelog_keys(root, pos[0]) if k.startswith(jira.project + '-')]
    if not keys:
        print('jira release: no Jira keys in CHANGELOG section %s' % pos[0])
        return 0
    try:  # a planned version with the same name would end up mixing shipped and planned issues
        names = [v.get('name') for v in jira.req('GET', '/rest/api/2/project/%s/versions'
                                                 % urllib.parse.quote(jira.project)) or []]
        held = jira.search('project = "%s" AND fixVersion = "%s"' % (jira.project, pos[0]), ['summary'],
                           100).get('issues', []) if pos[0] in names else []
    except NET_ERRORS as ex:
        sys.exit('jira release: %s' % ex)
    extra = sorted(i['key'] for i in held if i['key'] not in keys)
    if extra and not o.get('force'):
        planned = ['%s (%s)' % (e.id, e.value('Jira')) for p in tracker_files(root) for e in TrackerFile(p).entries
                   if e.value('Jira') in extra and target_of(e) == pos[0]]
        sys.exit('jira release: version %s already holds %d issue(s) not in CHANGELOG section %s: %s\n%s'
                 % (pos[0], len(extra), pos[0], ', '.join(extra[:20]),
                    ('Open entries still planned for it: %s. Move them first: `set <ID> Target <next>|unscheduled`.'
                     % ', '.join(planned)) if planned else
                    'It is a planned version with the same name: `jira version renumber %s=<new>` first, then re-run; '
                    '--force adds the shipped issues to it anyway.' % pos[0]))
    if o.get('dry-run'):
        print('jira release: would set fixVersion %s on %s' % (pos[0], ', '.join(keys)))
        return 0
    try:
        done = jira.add_fix_version(keys, pos[0])
    except NET_ERRORS as ex:
        sys.exit('jira release: %s' % ex)
    print('jira release: fixVersion %s set on %d issues' % (pos[0], len(done)))
    return 0


def planned_entries(root):
    """[(tracker path, Entry)] for every active entry."""
    return [(p, e) for p in tracker_files(root) for e in TrackerFile(p).entries]


def jira_versions(root, o):
    """jira versions [--json]: the project's versions with issue counts and the entries planned for each."""
    jira = jira_or_none(root)
    if not jira:
        sys.exit('jira versions: Jira is off or credentials are missing (jira doctor)')
    planned = {}
    for _, e in planned_entries(root):
        if target_of(e):
            planned[target_of(e)] = planned.get(target_of(e), 0) + 1
    rows = []
    try:
        for v in jira.versions():
            iss = jira.search_all('project = "%s" AND fixVersion = "%s"' % (jira.project, v['name']), ['status'])
            rows.append({'name': v['name'], 'id': v.get('id'), 'released': bool(v.get('released')),
                         'date': v.get('releaseDate') or '', 'issues': len(iss),
                         'open': sum(1 for i in iss if i['fields']['status']['statusCategory']['key'] != 'done'),
                         'entries': planned.pop(v['name'], 0), 'description': v.get('description') or ''})
    except NET_ERRORS as ex:
        sys.exit('jira versions: %s' % ex)
    planned.pop('unscheduled', None)
    if o.get('json'):
        print(json.dumps({'versions': rows, 'targets_without_version': planned}, indent=1))
        return 0
    print('%-12s %-8s %-10s %6s %5s %7s  %s' % ('version', 'released', 'date', 'issues', 'open', 'entries', 'description'))
    for r in rows:
        print('%-12s %-8s %-10s %6d %5d %7d  %s' % (r['name'], 'yes' if r['released'] else 'no', r['date'] or '-',
                                                   r['issues'], r['open'], r['entries'], r['description'][:60]))
    for name, n in sorted(planned.items()):
        print('%-12s not in Jira: %d entries target it (`jira version add %s`)' % (name, n, name))
    return 0


REPORT_FIELDS = ['summary', 'status', 'issuetype', 'fixVersions', 'created', 'resolutiondate', 'assignee']


def report_issue(i, epic_field):
    """One issue as status-log data: key, type, status category, epic or parent, fix versions, dates."""
    f = i.get('fields') or {}
    par = f.get(epic_field)
    if isinstance(par, dict):
        pkey, ptype = par.get('key'), ((par.get('fields') or {}).get('issuetype') or {}).get('name')
    else:
        pkey, ptype = par, ('epic' if par else None)  # Data Center Epic Link holds the epic's key
    st = f.get('status') or {}
    return {'key': i['key'], 'summary': f.get('summary') or '', 'type': (f.get('issuetype') or {}).get('name') or '',
            'status': st.get('name') or '', 'category': (st.get('statusCategory') or {}).get('key') or '',
            'parent': pkey, 'parent_type': ptype,
            'fix_versions': [v.get('name') for v in f.get('fixVersions') or []],
            'assignee': (f.get('assignee') or {}).get('displayName'),
            'created': (f.get('created') or '')[:10], 'resolved': (f.get('resolutiondate') or '')[:10]}


def report_worklog(key, x, since, until):
    """A worklog row when it started inside [SINCE, UNTIL] (dates, inclusive), else None. Comments are
    left out: only whether the cycle's worklog marker is present."""
    day = (x.get('started') or '')[:10]
    if not day or day < since or day > until:
        return None
    a = x.get('author') or {}
    return {'key': key, 'author': a.get('displayName') or a.get('name') or '',
            'author_id': a.get('accountId') or a.get('key') or a.get('name') or '',
            'started': x.get('started'), 'seconds': int(x.get('timeSpentSeconds') or 0),
            'cycle': '[cycle-worklog ' in str(x.get('comment') or '')}


def jira_report(root, o):
    """jira report [--since D] [--until D] [--out F]: read-only status-log data as JSON: the project's
    versions; every issue that is unresolved, on an unreleased version, resolved since D, or has a worklog
    in the window (with its epic); and every worklog by any author started in the window."""
    jira = jira_or_none(root)
    if not jira:
        sys.exit('jira report: Jira is off or credentials are missing (jira doctor)')
    today = datetime.date.today()
    until = o.get('until') or today.isoformat()
    since = o.get('since') or (today - datetime.timedelta(days=365)).isoformat()
    for d in (since, until):
        if not re.match(r'^\d{4}-\d{2}-\d{2}$', d):
            sys.exit('jira report: dates are YYYY-MM-DD, got %r' % d)
    epic_field = (jira.cfg.get('epics') or {}).get('field', 'parent')
    fields = REPORT_FIELDS + [epic_field]
    proj = jira.project
    try:
        versions = [{'name': v['name'], 'released': bool(v.get('released')), 'date': v.get('releaseDate') or '',
                     'description': v.get('description') or ''} for v in jira.versions()]
        found = jira.search_all('project = "%s" AND (statusCategory != Done OR fixVersion in unreleasedVersions() '
                                'OR resolved >= "%s")' % (proj, since), fields)
        logged = jira.search_all('project = "%s" AND worklogDate >= "%s" AND worklogDate <= "%s"'
                                 % (proj, since, until), fields)
        issues = {i['key']: report_issue(i, epic_field) for i in found + logged}
        worklogs = []
        for i in logged:
            start = 0
            while True:
                page = jira.req('GET', '/rest/api/2/issue/%s/worklog?startAt=%d&maxResults=1000'
                                % (urllib.parse.quote(i['key']), start)) or {}
                rows = page.get('worklogs') or []
                worklogs += [w for w in (report_worklog(i['key'], x, since, until) for x in rows) if w]
                start += len(rows)
                if not rows or start >= int(page.get('total') or 0):
                    break
    except NET_ERRORS as ex:
        sys.exit('jira report: %s' % ex)
    out = {'project': proj, 'since': since, 'until': until, 'epic_type': jira.issue_type('epic'),
           'versions': versions, 'issues': sorted(issues.values(), key=lambda r: r['key']),
           'worklogs': sorted(worklogs, key=lambda w: (w['started'] or '', w['key']))}
    text = json.dumps(out, indent=1)
    if o.get('out'):
        with open(o['out'], 'w', encoding='utf-8') as fh:
            fh.write(text + '\n')
        print('jira report: %d issues, %d worklogs -> %s' % (len(out['issues']), len(worklogs), o['out']))
    else:
        print(text)
    return 0


VERSION_FIELDS = ['summary', 'status', 'issuetype', 'assignee', 'fixVersions']


def entries_by_key(root, app=None):
    """{Jira key: [(app, path, Entry)]} for active entries (a cross-app id has one slice per tracker)."""
    cfg, out = load_config(root), {}
    for p in tracker_files(root):
        a = app_of(root, p, cfg)
        if app and a != app:
            continue
        for e in TrackerFile(p).entries:
            k = e.value('Jira') or ''
            if KEY_RE.match(k):
                out.setdefault(k, []).append((a, p, e))
    return out


def version_drift(jira, wf, name, issues, by_key, ledger, root, app=None):
    """One row per issue in version NAME or entry targeting it. Each row: key, ids, jira status,
    tracker status, state (left | done), drift (None or text), fix ((verb, key, arg) or None).
    The trackers are the source: Target decides membership, Status decides the column
    (moves only forward); everything else is reported, never changed."""
    rows, seen = [], set()
    for iss in issues:
        k, f = iss['key'], iss['fields']
        seen.add(k)
        st = (f['status']['name'], f['status']['statusCategory']['key'])
        slices = by_key.get(k, [])
        r = {'key': k, 'ids': sorted({e.id for _, _, e in slices}), 'summary': f.get('summary') or '',
             'type': (f.get('issuetype') or {}).get('name', ''), 'jira': st[0],
             'assignee': (f.get('assignee') or {}).get('displayName') or '',
             'tracker': ', '.join(sorted({e.status() for _, _, e in slices})) or ('ledger' if k in ledger else '-'),
             'state': 'done' if st[1] == 'done' else 'left', 'drift': None, 'fix': None, 'in_jira': True}
        targets = {target_of(e) for _, _, e in slices}
        if not slices:
            if k in ledger:
                if st[1] != 'done':
                    r.update(drift='shipped (CHANGELOG) but not Done in Jira', fix=('done', k, None))
            elif not app:
                r['drift'] = 'no tracker entry (made in Jira, or its entry left without a ledger line: `jira done %s`)' % k
        elif len(targets) > 1:
            r['drift'] = 'slices disagree on Target: %s (fix the trackers first)' % ', '.join(sorted(t or 'none' for t in targets))
        elif targets == {None}:
            r['drift'] = 'entry has no Target (planned only in Jira: `set %s Target %s` keeps it)' % (r['ids'][0], name)
        elif name not in targets:
            t = targets.pop()
            r.update(drift='entry Target is %s' % t, fix=('target', k, t))
        if r['drift'] is None and slices:
            r['drift'], r['fix'] = status_drift(jira, wf, k, st, slices[0][2])
        rows.append(r)
    absent = [k for k, sl in sorted(by_key.items()) if k not in seen and name in {target_of(e) for _, _, e in sl}]
    cols = jira.statuses(absent) if absent else {}
    for k in absent:
        slices = by_key[k]
        st = cols.get(k)
        rows.append({'key': k, 'ids': sorted({e.id for _, _, e in slices}), 'summary': slices[0][2].title,
                     'type': '', 'jira': st[0] if st else 'not found', 'assignee': '', 'in_jira': False,
                     'tracker': ', '.join(sorted({e.status() for _, _, e in slices})),
                     'state': 'done' if st and st[1] == 'done' else 'left',
                     'drift': 'targets %s; issue lacks the fix version' % name if st else 'issue %s not found in Jira' % k,
                     'fix': ('target', k, name) if st else None})
    for p in tracker_files(root):
        if app and app_of(root, p, load_config(root)) != app:
            continue
        for e in TrackerFile(p).entries:
            if target_of(e) == name and not KEY_RE.match(e.value('Jira') or ''):
                rows.append({'key': '-', 'ids': [e.id], 'summary': e.title, 'type': '', 'jira': '-', 'assignee': '', 'in_jira': False,
                             'tracker': e.status(), 'state': 'left',
                             'drift': 'no Jira issue yet (`jira sync`)', 'fix': None})
    return rows


def status_drift(jira, wf, key, st, e):
    """(drift, fix) for an active entry against its issue's column; the board only moves forward."""
    name, cat = st
    s = e.status()
    if cat == 'done':
        return 'Done in Jira, still %s in the tracker' % s, None
    if s == 'in-progress':
        goal = wf['inProgress']
        behind = CAT_RANK[cat] < CAT_RANK[goal] if goal in CAT_RANK else jira.rank(name, cat, wf) < jira.target_rank(goal, wf)
        return ('in-progress in the tracker, "%s" in Jira' % name, ('move', key, goal)) if behind else (None, None)
    if s.endswith('pending-migration'):
        v = gate_verdict(jira, wf, key, st)
        return ('moved back on the board ("%s"): `jira status --apply`' % name, None) if v == 'rejected' else (None, None)
    if s == 'open' and cat != 'new':
        return 'open in the tracker, "%s" in Jira (`set %s Status in-progress` if work started)' % (name, e.id), None
    return None, None


def version_names(jira, root, pos, everything):
    """NAMEs given, else every unreleased Jira version plus every Target the trackers use."""
    if pos:
        return list(pos)
    names = [v['name'] for v in jira.versions() if everything or not v.get('released')]
    names += sorted({target_of(e) for _, e in planned_entries(root)} - set(names) - {None, 'unscheduled'})
    return names


def jira_version_show(root, o, pos, reconcile=False):
    """jira version show|reconcile [NAME...] [--open] [--app A] [--json] [--dry-run]."""
    verb = 'reconcile' if reconcile else 'show'
    jira = jira_or_none(root)
    if not jira:
        sys.exit('jira version %s: Jira is off or credentials are missing (jira doctor)' % verb)
    dry, app = bool(o.get('dry-run')), o.get('app')
    try:
        wf = fit_workflow(jira, workflow(load_config(root)))
        meta = {v['name']: v for v in jira.versions()}
        names = version_names(jira, root, pos, False)
        by_key, ledger = entries_by_key(root, app), set(changelog_keys(root))
        report, left_drift = [], 0
        for name in names:
            v = meta.get(name)
            issues = jira.search_all('project = "%s" AND fixVersion = "%s"' % (jira.project, name), VERSION_FIELDS) if v else []
            rows = version_drift(jira, wf, name, issues, by_key, ledger, root, app)
            report.append((name, v, rows))
    except NET_ERRORS as ex:
        sys.exit('jira version %s: %s' % (verb, ex))
    if o.get('json') and not reconcile:
        print(json.dumps([{'version': n, 'in_jira': bool(v), 'released': bool(v and v.get('released')),
                           'date': (v or {}).get('releaseDate') or '',
                           'issues': [dict((k, x) for k, x in r.items() if k != 'fix') for r in rows
                                      if not o.get('open') or r['state'] == 'left']} for n, v, rows in report], indent=1))
        return 0
    made = set(meta)
    for name, v, rows in report:
        inj = [r for r in rows if r['in_jira']]
        left = [r for r in inj if r['state'] == 'left']
        cols = {}
        for r in left:
            cols[r['jira']] = cols.get(r['jira'], 0) + 1
        extra = len(rows) - len(inj)
        print('%s  %s  %d in Jira: %d left (%s), %d done%s%s' % (
            name, 'not in Jira' if not v else 'released %s' % v.get('releaseDate', '') if v.get('released')
            else 'unreleased' + (' (%s)' % v['releaseDate'] if v.get('releaseDate') else ''),
            len(inj), len(left), ', '.join('%d %s' % (n, c) for c, n in sorted(cols.items())) or '-',
            len(inj) - len(left), '; +%d planned in the trackers only' % extra if extra else '',
            '' if v else '  (`jira version add %s`)' % name))
        shown = [r for r in rows if not o.get('open') or r['state'] == 'left' or r['drift']]
        shown.sort(key=lambda r: (r['state'] != 'left', r['key']))
        for r in shown:
            print('  %-11s %-22s %-14s %-24s %-14s %s' % (r['key'], ','.join(r['ids']) or '-', r['jira'][:14],
                                                       r['tracker'][:24], r['assignee'][:14], r['summary'][:60]))
            if r['drift']:
                print('              drift: %s%s' % (r['drift'], '  [fixable]' if r['fix'] and not reconcile else ''))
        drift = [r for r in rows if r['drift']]
        if not reconcile:
            fixable = sum(1 for r in drift if r['fix'])
            if drift:
                print('  %d drift: %s' % (len(drift), '%d fixable (`jira version reconcile %s --dry-run`), the rest by hand'
                                          % (fixable, name) if fixable else 'none fixable from the trackers; act on each line'))
            continue
        for r in drift:
            if not r['fix']:
                left_drift += 1
                continue
            verb_, key, arg = r['fix']
            if dry:
                col = lambda t: {'indeterminate': 'an in-progress status', 'done': 'a done status'}.get(t, '"%s"' % t)
                print('  would %s' % {'target': 'set %s fix version to %s' % (key, arg), 'move': 'move %s to %s' % (key, col(arg)),
                                       'done': 'move %s to %s' % (key, col(wf['done']))}[verb_])
                left_drift += 1
                continue
            if verb_ == 'target':
                ok = jira_target(jira, key, arg, made)  # creates a missing version bare
            elif verb_ == 'move':
                ok = jira_move(jira, key, arg, wf)
            else:
                ok = not done_keys(jira, wf, [(key, None)], False)
            left_drift += 0 if ok else 1
    if reconcile:
        print('jira version reconcile: %d version(s); %d drift %s%s' % (
            len(report), left_drift, 'left (report-only or dry run)' if left_drift else 'left', ' (dry run)' if dry else ''))
        return 1 if left_drift else 0
    return 0


def rename_steps(pairs, existing):
    """Order renames OLD->NEW so no step hits a name in use; a cycle goes through a temporary name."""
    occupied, todo, steps = set(existing), dict(pairs), []
    while todo:
        ready = sorted(old for old, new in todo.items() if new not in occupied)
        if ready:
            old = ready[-1]
            new = todo.pop(old)
        else:
            old = sorted(todo)[-1]
            new = old + '-renumber'
            while new in occupied:
                new += '-'
            todo[new] = todo.pop(old)
        steps.append((old, new))
        occupied.discard(old)
        occupied.add(new)
    return steps


def retarget(root, mapping, dry):
    """Rewrite Target OLD -> NEW on every entry; returns the number of entries that change."""
    n = 0
    for p in tracker_files(root):
        tf = TrackerFile(p)
        hit = [e for e in tf.entries if target_of(e) in mapping]
        if hit and not dry:
            for e in hit:
                e.set(tf.kind, 'Target', mapping[target_of(e)])
            tf.save()
        n += len(hit)
    return n


def jira_version(root, o, pos):
    """jira version add|edit|renumber|release ...: planned and shipped versions, through this script only."""
    if pos and pos[0] in ('show', 'reconcile'):
        return jira_version_show(root, o, pos[1:], reconcile=pos[0] == 'reconcile')
    if not pos or pos[0] not in ('add', 'edit', 'renumber', 'release') or len(pos) < 2:
        sys.exit('usage: jira version add NAME [--description D] [--released [--date D]] | edit NAME [--rename NEW] '
                 '[--description D] | renumber OLD=NEW... | release NAME [--date D]   (--dry-run on all)\n'
                 '       jira version show [NAME...] [--open] [--app A] [--json] | reconcile [NAME...] [--app A] [--dry-run]')
    verb, args, dry = pos[0], pos[1:], bool(o.get('dry-run'))
    tag = ' (dry run)' if dry else ''
    jira = jira_or_none(root)
    if verb == 'renumber':
        pairs = [tuple(a.split('=', 1)) for a in args]
        if any(len(x) != 2 or not VERSION_NAME_RE.match(x[1]) for x in pairs):
            sys.exit('jira version renumber: give OLD=NEW pairs, NEW as vX.Y.Z')
        if len({n for _, n in pairs}) != len(pairs):
            sys.exit('jira version renumber: two versions renamed to the same name')
        mapping = dict(pairs)
        if jira:
            try:
                existing = {v['name']: v for v in jira.versions()}
            except NET_ERRORS as ex:
                sys.exit('jira version renumber: %s' % ex)
            gone = [a for a in mapping if a not in existing]
            taken = [b for b in mapping.values() if b in existing and b not in mapping]
            if gone or taken:
                sys.exit('jira version renumber: %s%s' % ('not in Jira: %s. ' % ', '.join(gone) if gone else '',
                                                          'already used: %s' % ', '.join(taken) if taken else ''))
            ids = {n: v['id'] for n, v in existing.items()}
            for old, new in rename_steps(pairs, existing):
                print('  rename %s -> %s%s' % (old, new, tag))
                if not dry:
                    jira.update_version(ids[old], {'name': new})
                ids[new] = ids.pop(old)
        else:
            print('jira version renumber: Jira off or no credentials; trackers only')
        n = retarget(root, mapping, dry)
        print('jira version renumber: %d version(s); Target rewritten on %d entries%s' % (len(pairs), n, tag))
        return 0
    name = args[0]
    if not jira:
        sys.exit('jira version %s: Jira is off or credentials are missing (jira doctor)' % verb)
    try:
        cur = jira.version(name)
        if verb == 'add':
            if cur:
                sys.exit('jira version add: %s already exists' % name)
            print('jira version add: %s%s%s' % (name, ' (released %s)' % (o.get('date') or today()) if o.get('released') else '', tag))
            if not dry:
                jira.create_version(name, o.get('description'), bool(o.get('released')), o.get('date'))
            return 0
        if not cur:
            sys.exit('jira version %s: no version %s in %s' % (verb, name, jira.project))
        if verb == 'edit':
            fields = {}
            if o.get('rename'):
                if jira.version(o['rename']):
                    sys.exit('jira version edit: %s already exists (`renumber` swaps names)' % o['rename'])
                fields['name'] = o['rename']
            if 'description' in o:
                fields['description'] = o['description']
            if not fields:
                sys.exit('jira version edit: nothing to change (--rename, --description)')
            print('jira version edit %s: %s%s' % (name, ', '.join('%s=%s' % kv for kv in sorted(fields.items())), tag))
            if 'name' in fields:
                print('  Target rewritten on %d entries' % retarget(root, {name: fields['name']}, dry))
            if not dry:
                jira.update_version(cur['id'], fields)
            return 0
        date = o.get('date') or changelog_sections(ledger_paths(root)).get(name.lstrip('v')) or today()
        still = [e.id for _, e in planned_entries(root) if target_of(e) == name]
        if still:
            print('  note: entries still planned for %s: %s (`set <ID> Target <next>|unscheduled`)' % (name, ', '.join(still)))
        print('jira version release: %s %s %s%s' % (name, 'already released' if cur.get('released') else 'released', date, tag))
        if not dry and not cur.get('released'):
            jira.update_version(cur['id'], {'released': True, 'releaseDate': date})
        return 0
    except NET_ERRORS as ex:
        sys.exit('jira version %s: %s' % (verb, ex))


def read_plan(path):
    """Plan file -> ([(version, description, [ids])], [unscheduled ids]). JSON
    {"versions": [{"name", "description", "ids"}], "unscheduled": [ids]}, or Markdown: a heading
    `## vX.Y.Z - description` or `## Unscheduled`, then any lines naming BUG-/FEAT- ids."""
    text = read(path)
    if text.lstrip().startswith('{'):
        d = json.loads(text)
        return ([(v['name'], v.get('description'), list(v.get('ids') or [])) for v in d.get('versions') or []],
                list(d.get('unscheduled') or []))
    vers, unsched, cur = [], [], None
    for line in text.split('\n'):
        m = re.match(r'^#{1,4}\s+(v\d+\.\d+\.\d+|unscheduled)\b[\s:—–-]*(.*)$', line, re.I)
        if m:
            if m.group(1).lower() == 'unscheduled':
                cur = unsched
            else:
                vers.append((m.group(1), m.group(2).strip() or None, []))
                cur = vers[-1][2]
        elif line.startswith('#'):
            cur = None
        elif cur is not None:
            cur += re.findall(r'\b((?:BUG|FEAT)-\d+[a-z]*)\b', line)
    return vers, unsched


def cmd_plan(argv):
    """plan --from FILE [--dry-run] [--no-jira]: write Target on the planned entries; in Jira create or
    describe the versions and set each issue's planned fix version (set semantics)."""
    o, _ = opts(argv, flags=('dry-run', 'no-jira'))
    if not o.get('from'):
        sys.exit('usage: plan --from FILE [--dry-run] [--no-jira]   (.cycle/TRACKERS-jira.md, "Planned releases")')
    root, dry = repo_root(), bool(o.get('dry-run'))
    vers, unsched = read_plan(o['from'])
    bad = [n for n, _, _ in vers if not VERSION_NAME_RE.match(n)]
    if bad:
        sys.exit('plan: version names are vX.Y.Z: %s' % ', '.join(bad))
    want = {}
    for name, ids in [(n, i) for n, _, i in vers] + [('unscheduled', unsched)]:
        for i in ids:
            want.setdefault(i, set()).add(name)
    twice = sorted('%s (%s)' % (i, '/'.join(sorted(v))) for i, v in want.items() if len(v) > 1)
    if twice:
        sys.exit('plan: ids in more than one version: %s' % ', '.join(twice))
    want = {i: v.pop() for i, v in want.items()}
    entries = planned_entries(root)
    missing = sorted(set(want) - {e.id for _, e in entries})
    if missing:
        sys.exit('plan: not active in any tracker: %s' % ', '.join(missing))
    order = [n for n, _, _ in vers] + ['unscheduled']
    rows = {}
    for _, e in entries:
        old, new = target_of(e), want.get(e.id)
        if new:
            rows.setdefault(new, [set(), set(), set()])[0 if old != new else 2].add(e.id)
        if old and old != new and new:
            rows.setdefault(old, [set(), set(), set()])[1].add(e.id)
    print('%-12s %6s %6s %6s' % ('version', 'added', 'left', 'kept'))
    for v in order + sorted(set(rows) - set(order)):
        if v in rows or v != 'unscheduled':
            a, l, k = rows.get(v, (set(), set(), set()))
            print('%-12s %6d %6d %6d%s' % (v, len(a), len(l), len(k), '  + ' + ' '.join(sorted(a)) if a else ''))
    unplanned = sorted({e.id for _, e in entries if e.id not in want})
    if unplanned:
        print('unplanned, Target left as is: %s' % ', '.join(unplanned))
    changed = 0
    for p in tracker_files(root):
        tf = TrackerFile(p)
        hit = [e for e in tf.entries if e.id in want and target_of(e) != want[e.id]]
        changed += len(hit)
        if hit and not dry:
            for e in hit:
                e.set(tf.kind, 'Target', want[e.id])
            tf.save()
    tag = ' (dry run)' if dry else ''
    jira = None if o.get('no-jira') else jira_or_none(root)
    if not jira:
        print('plan: Target %s on %d entries%s; Jira %s' % ('would change' if dry else 'written', changed, tag,
                                                             'skipped' if o.get('no-jira') else 'off or no credentials'))
        return 0
    try:
        have = {v['name']: v for v in jira.versions()}
        for name, desc, _ in vers:
            cur = have.get(name)
            if not cur:
                print('  create version %s%s%s' % (name, ' - ' + desc if desc else '', tag))
                if not dry:
                    jira.create_version(name, desc)
            elif cur.get('released'):
                print('  warning: %s is released in Jira; plan onto a new number' % name)
            elif desc and (cur.get('description') or '') != desc:
                print('  describe %s%s' % (name, tag))
                if not dry:
                    jira.update_version(cur['id'], {'description': desc})
    except NET_ERRORS as ex:
        sys.exit('plan: %s' % ex)
    keyed = [(e.value('Jira'), want[e.id]) for _, e in entries if e.id in want and KEY_RE.match(e.value('Jira') or '')]
    made = set(have) | {n for n, _, _ in vers}
    fails = 0 if dry else sum(0 if jira_target(jira, k, t, made) else 1 for k, t in keyed)
    print('plan: Target %s on %d entries; %d issues %s%s' % ('would change' if dry else 'written', changed, len(keyed),
                                                            'would get their fix version' if dry else 'checked', tag)
          + (', %d failed' % fails if fails else ''))
    return 1 if fails else 0


def doctor_workflow(jira, j, write_it):
    """Check jira.workflow against the project's statuses; propose one when missing. Returns (ok, changed, wf)."""
    st = jira.project_statuses()
    names = {v[0] for v in st.values()}
    print('statuses    %s' % ', '.join('%s (%s)' % v for v in sorted(st.values(), key=lambda v: (CAT_RANK.get(v[1], 1), v[0]))))
    try:
        perm = jira.req('GET', '/rest/api/2/mypermissions?projectKey=%s&permissions=TRANSITION_ISSUES,RESOLVE_ISSUES,EDIT_ISSUES'
                        % urllib.parse.quote(jira.project)).get('permissions', {})
        for p in ('TRANSITION_ISSUES', 'RESOLVE_ISSUES', 'EDIT_ISSUES'):
            print('permission  %-18s %s' % (p, 'yes' if (perm.get(p) or {}).get('havePermission') else 'NO'))
        ok = (perm.get('TRANSITION_ISSUES') or {}).get('havePermission', True)
    except JiraError:
        ok = True
    w = dict(j.get('workflow') or {})
    changed = False
    if not w:
        pick = lambda rx, cat=None: next((v[0] for v in sorted(st.values()) if re.search(rx, v[0], re.I)
                                          and (cat is None or v[1] == cat)), None)
        w = {k: v for k, v in {
            'inProgress': pick(r'progress', 'indeterminate'),
            'review': pick(r'review', 'indeterminate'),
            'gate': [g for g in [pick(r'awaiting migration|ready for (migration|release|prod)', 'indeterminate')] if g],
            'done': pick(r'^(done|complete|completed|resolved|closed)$', 'done'),
        }.items() if v}
        qa = [v[0] for v in st.values() if v[1] == 'indeterminate' and re.search(r'\bqa\b|test|staging|verif', v[0], re.I)
              and v[0] not in w.get('gate', [])]
        w['order'] = [x for x in [pick(r'to ?do|backlog|open', 'new'), w.get('inProgress'), w.get('review')] + qa
                      + w.get('gate', []) + [w.get('done')] if x]
        changed = True
        print('workflow    proposed: %s' % json.dumps(w))
    else:
        for k in ('inProgress', 'review', 'done'):
            if w.get(k) and w[k] not in CAT_RANK and w[k] not in names:
                print('workflow    %s "%s" is not a status in %s' % (k, w[k], jira.project))
                ok = False
        gates = [w['gate']] if isinstance(w.get('gate'), str) else list(w.get('gate') or [])
        for g in dict.fromkeys(gates + list(w.get('order') or [])):
            if g not in names:
                print('workflow    "%s" is not a status in %s' % (g, jira.project))
                ok = False
        print('workflow    %s' % json.dumps(w))
    return ok, changed, w


def wiki(text):
    """Markdown-ish tracker text to Jira wiki markup (code fences only)."""
    out, fence = [], False
    for l in (text or '').split('\n'):
        m = FENCE_RE.match(l)
        if m:
            lang = l.strip()[3:].strip()
            out.append('{code}' if fence else ('{code:%s}' % lang if lang else '{code}'))
            fence = not fence
            continue
        out.append(l)
    if fence:
        out.append('{code}')
    return '\n'.join(out).strip()


SYSTEM_FIELDS = {'project', 'issuetype', 'summary', 'description', 'reporter', 'priority', 'labels',
                 'parent', 'components', 'assignee', 'attachment', 'issuelinks'}


def _source(e, app, src):
    """A field-map source: a tracker field name, @areas, @title, @id, @app, @external, or =literal."""
    if src.startswith('='):
        return src[1:]
    if src == '@areas':
        return [a.strip() for a in (e.value('Area') or '').split(',') if a.strip() and a.strip() != 'unknown']
    if src in ('@title', '@id', '@app', '@external'):
        return {'@title': e.title, '@id': e.id, '@app': app, '@external': '%s:%s' % (app, e.id)}[src]
    v = e.text(src)
    if v is None or v.strip().lower() in ('none', 'unknown', 'n/a', ''):
        return None
    return wiki(v)


def _convert(value, spec, meta):
    """Shape a value for the field's schema (text, option, multi-option, component, labels, number)."""
    vmap = {k.lower(): v for k, v in (spec.get('valueMap') or {}).items()}
    if isinstance(value, list) and spec.get('from') == '@areas':
        # match option lists on tag parts too ("build / tooling" -> build, tooling)
        value = list(dict.fromkeys(value + [w.strip() for a in value for w in re.split(r'[/()]', a) if w.strip()]))
    vals = value if isinstance(value, list) else ([] if value is None else [value])
    vals = [vmap.get(str(v).lower(), v) for v in vals]
    schema = (meta or {}).get('schema') or {}
    typ, items = schema.get('type'), schema.get('items')
    allowed = (meta or {}).get('allowed') or []
    if allowed:
        low = {a.lower(): a for a in allowed if a}
        vals = [low[str(v).lower()] for v in vals if str(v).lower() in low]
    if not vals and spec.get('default') is not None:
        vals = spec['default'] if isinstance(spec['default'], list) else [spec['default']]
    if not vals:
        return None
    if typ == 'array' and items in ('option', 'component', 'version'):
        key = 'value' if items == 'option' else 'name'
        return [{key: v} for v in vals]
    if typ == 'array':
        return [re.sub(r'\s+', '-', str(v)) for v in vals]
    if typ == 'option':
        return {'value': vals[0]}
    if typ == 'number':
        try:
            return float(vals[0])
        except ValueError:
            return None
    return ', '.join(str(v) for v in vals) if len(vals) > 1 else str(vals[0])


def issue_fields(e, kind, app, jira, cross):
    def t(n):
        v = e.text(n)
        return None if v is None or v.strip().lower() in ('none', 'unknown', 'n/a', '') else v

    fmap = jira.field_map(kind)
    try:
        meta = jira.meta(kind) if fmap and jira.site and jira.token else {}
    except (JiraError, urllib.error.URLError):
        meta = {}
    mapped = {v if isinstance(v, str) else v.get('from') for v in fmap.values()}
    sections = (['Observation', 'Expected', 'File(s)', 'Repro / Notes'] if kind == 'bug' else
                ['Why', 'UI', 'Approach', 'Library / dependency notes', 'Out of scope', 'File(s)',
                 'Acceptance criteria', 'Test plan'])
    desc = ['Tracker: %s %s (%s)' % (app, e.id, 'cross-app' if cross else 'single app')]
    for n, label in (('Req', 'Requirements'), ('Depends on', 'Blocked by')):
        if t(n):
            desc.append('%s: %s' % (label, t(n)))
    for n in sections:
        if t(n) and n not in mapped:
            desc.append('\n*%s:*\n%s' % (n, wiki(t(n))))
    areas = _source(e, app, '@areas')
    labels = [e.id.lower(), app] + [re.sub(r'[^A-Za-z0-9_.-]+', '-', a) for a in areas]
    if cross:
        labels.append('cross-app')
    level = e.value('Severity' if kind == 'bug' else 'Priority')
    summary = '%s (%s, %s)' % (e.title, app, e.id)
    f = {'project': {'key': jira.project}, 'issuetype': {'name': jira.issue_type(kind)},
         'summary': summary if len(summary) <= 255 else summary[:252] + '...',
         'description': '\n'.join(desc), 'labels': list(dict.fromkeys(labels))}
    if level in PRIORITY_JIRA:
        f['priority'] = {'name': PRIORITY_JIRA[level]}
    ext = jira.field_id('externalId')
    if ext:
        f[ext] = '%s:%s' % (app, e.id)
    for fid, spec in fmap.items():
        spec = {'from': spec} if isinstance(spec, str) else spec
        v = _convert(_source(e, app, spec['from']), spec, meta.get(fid))
        if v is not None:
            f[fid] = v
    epic, _ = jira.epic_for(e, app)
    if epic:
        fld = (jira.cfg.get('epics') or {}).get('field', 'parent')
        f[fld] = {'key': epic} if fld == 'parent' else epic
    if jira.cfg.get('components') and areas and 'components' not in f:
        f['components'] = [{'name': a} for a in areas]
    return f


def jira_for_entries(root, targets, dry, quiet_missing_creds=False, source=None, limit=None):
    """targets: [(tracker_path, id, Entry-or-None)]; creates or links issues, writes keys back."""
    cfg = load_config(root)
    if jira_mode(root) == 'off':
        if quiet_missing_creds:
            return 0
        sys.exit('jira: off for this repo (no `jira` block in .cycle/tracker.json; see .cycle/TRACKERS-jira.md "Jira setup")')
    jira = Jira(cfg)
    miss = jira.missing()
    if miss and not dry:
        if quiet_missing_creds:
            print('jira: %s not set; saved without a Jira issue (`jira sync` creates it later)' % ', '.join(miss))
            return 0
        sys.exit('jira: %s not set in this terminal. Set them (.cycle/TRACKERS-jira.md, "Jira setup"), '
                 'open a new terminal, then run `jira doctor`.' % ', '.join(miss))
    ids = all_ids(root)
    made = linked = failed = gaps = noepic = 0
    wf, vmade = None, set()
    rows = []
    for item in targets[:limit] if limit else targets:
        path, eid = item[0], item[1]
        tf = TrackerFile(path)
        cur = tf.get(eid)
        if cur is None:
            print('skip %s: not in %s' % (eid, rel_or_abs(path, root)))
            continue
        e = item[2] if len(item) > 2 and item[2] is not None else cur
        if KEY_RE.match(cur.value('Jira') or ''):
            continue
        app = app_of(root, path, cfg)
        cross = len(ids.get(eid, [])) > 1
        fields = issue_fields(e, tf.kind, app, jira, cross)
        if dry:
            gap = ''
            if not jira.missing():
                try:
                    fmap = jira.field_map(tf.kind)
                    need = []
                    for fid, m in jira.meta(tf.kind).items():
                        if m['required'] and fid not in SYSTEM_FIELDS and not fields.get(fid):
                            src = fmap.get(fid)
                            src = src if isinstance(src, str) else (src or {}).get('from')
                            need.append('%s (%s)' % (m['name'], 'entry has no %s: `set %s "%s" …`' % (src, eid, src)
                                                     if src and not src.startswith(('@', '=')) else
                                                     'not in the field map: `jira doctor`' if not src else 'no value'))
                except (JiraError, urllib.error.URLError):
                    need = []
                if need:
                    gaps += 1
                    gap = '  MISSING: %s' % ', '.join(need)
            epic, how = jira.epic_for(e, app)
            if not epic:
                noepic += 1
            rows.append('%-28s %-5s %-7s %-9s %s%s' % ('%s:%s' % (app, eid), fields['issuetype']['name'],
                                                       (fields.get('priority') or {}).get('name', '-'),
                                                       epic or '-', fields['summary'][:72], gap))
            continue
        try:
            key = jira.find_existing('%s:%s' % (app, eid), [eid.lower(), app])
            if key:
                linked += 1
                how = 'linked existing'
            else:
                key = jira.create(fields)
                made += 1
                how = 'created'
        except (JiraError, urllib.error.URLError) as ex:
            failed += 1
            why = str(ex)
            if isinstance(ex, JiraError) and ex.code == 400:
                try:
                    errs = json.loads(ex.body).get('errors') or {}
                    why = '; '.join('%s (%s)' % (m.rstrip('.'), k) for k, m in errs.items()) or why
                except ValueError:
                    pass
            print('FAILED %s:%s %s' % (app, eid, why))
            continue
        cur.set(tf.kind, 'Jira', key)
        epic, why = jira.epic_for(e, app)
        if epic and why in ('rule', 'default') and not cur.value('Jira parent'):
            cur.set(tf.kind, 'Jira parent', epic)
        tf.save()
        print('%s %s -> %s' % (how, '%s:%s' % (app, eid), key))
        st = cur.status()
        if st == 'in-progress' or st.endswith('pending-migration'):  # board follows the entry (TRACKERS.md)
            wf = wf or fit_workflow(jira, workflow(cfg))
            if status_target(st, wf):
                jira_move(jira, key, status_target(st, wf), wf)
        if target_of(cur):
            jira_target(jira, key, target_of(cur), vmade)
        if source:
            set_export_key(source, path, root, eid, key)
    if dry:
        print('%-28s %-5s %-7s %-9s %s' % ('external id', 'type', 'prio', 'epic', 'summary'))
        print('\n'.join(rows))
        print('(each is looked up by External ID first; existing issues are linked, not duplicated)')
        print('dry run: %d issues would be created or linked' % len(rows))
        if noepic:
            print('%d have no epic: set `Jira parent` (pick from `jira epics`) or add jira.epics.rules' % noepic)
        if gaps:
            print('%d would fail: a required Jira field gets no value (see MISSING above)' % gaps)
        elif jira.missing():
            print('(credentials not set, so required Jira fields were not checked)')
        return 0
    print('jira: %d created, %d linked to existing issues, %d failed' % (made, linked, failed))
    if failed:
        print('a required Jira field got no value: `jira sync --dry-run` names it per entry (fill the entry'
              ' with `set`, or fix the field map with `jira doctor --write`)')
    return 1 if failed else 0


def set_export_key(source, path, root, eid, key):
    text = read(source)
    rel = rel_or_abs(path, root).replace('\\', '/')
    parts = re.split(r'(?m)^(?=## )', text)
    for i, part in enumerate(parts):
        if part.startswith('## ') and part[3:].split('\n')[0].strip() == rel:
            parts[i] = re.sub(r'(?m)(^### \[%s\][^\n]*\n(?:(?!### \[).*\n)*?- \*\*Jira:\*\*) \S+' % re.escape(eid),
                              r'\1 ' + key, part)
    write(source, ''.join(parts))


def cmd_jira(argv):
    if not argv or argv[0] not in ('doctor', 'push', 'sync', 'configure', 'epics', 'epic', 'parents', 'status', 'done',
                                   'release', 'versions', 'version', 'report'):
        sys.exit('usage: jira doctor [--write] | jira push FILE [--dry-run] | jira sync [--app A] [--dry-run] [--limit N]\n'
                 '       jira epics [--json] | jira epic add NAME [--scope S] [--req IDS] [--dry-run] [--json]\n'
                 '       jira parents [--dry-run] [--force] [--app A] | jira versions [--json] | jira report [--since D] [--until D] [--out F]\n'
                 '       jira version add NAME [--description D] [--released [--date D]] | edit NAME [--rename NEW] [--description D]\n'
                 '       jira version renumber OLD=NEW... | release NAME [--date D]   (all take --dry-run)\n'                 '       jira version show [NAME...] [--open] [--app A] [--json] | reconcile [NAME...] [--app A] [--dry-run]\n'
                 '       jira status [--apply] [--app A] | jira done [KEY...] [--dry-run] | jira release VERSION [--dry-run] [--force]\n'
                 '       jira configure --mode enforce|optional|off [--site URL --project KEY] [--auth basic|bearer]\n'
                 '                      [--email-env VAR --token-env VAR] [--bug-type T --feature-type T]')
    sub, rest = argv[0], argv[1:]
    root = repo_root()
    cfg = load_config(root)
    o, pos = opts(rest, flags=('dry-run', 'write', 'force', 'apply', 'json', 'released', 'open'))
    dry = bool(o.get('dry-run'))
    if sub == 'status':
        return jira_status(root, o)
    if sub == 'done':
        return jira_done(root, o, pos)
    if sub == 'release':
        return jira_release(root, o, pos)
    if sub == 'versions':
        return jira_versions(root, o)
    if sub == 'report':
        return jira_report(root, o)
    if sub == 'version':
        return jira_version(root, o, pos)
    if sub == 'epic':
        return jira_epic(root, o, pos)
    limit = int(o['limit']) if o.get('limit') else None
    if sub == 'doctor':
        return jira_doctor(root, cfg, o)
    if sub == 'configure':
        return jira_configure(root, cfg, o)
    if sub in ('epics', 'parents'):
        jira = Jira(cfg)
        if jira_mode(root) == 'off' or jira.missing():
            sys.exit('jira: %s' % ('off for this repo' if jira_mode(root) == 'off'
                                   else '%s not set' % ', '.join(jira.missing())))
        if sub == 'epics':
            if o.get('json'):  # with each epic's description: its scope, for matching tickets
                print(json.dumps([{'key': k, 'name': n, 'description': d[:600]} for k, n, d in jira.epics(full=True)], indent=1))
                return 0
            for key, summary in jira.epics():
                print('%-10s %s' % (key, summary))
            return 0
        return jira_parents(root, cfg, jira, o)
    if sub == 'push':
        if not pos:
            sys.exit('usage: jira push FILE.md [--dry-run]')
        targets = []
        for rel, e in parse_export(pos[0]):
            p = os.path.join(root, rel)
            if not os.path.exists(p):
                print('skip %s: tracker %s not found' % (e.id, rel))
                continue
            errs = [x for x in lint_entry(e, kind_of(p)) if x[1] == 'E' and x[0] not in ('ORDER', 'BOX', 'INDENT')]
            if errs:
                print('skip %s: %s' % (e.id, '; '.join(m for _, _, m in errs)))
                continue
            targets.append((p, e.id, e))
        return jira_for_entries(root, targets, dry, source=None if dry else pos[0], limit=limit)
    targets = []
    for p in tracker_files(root):
        if o.get('app') and app_of(root, p, cfg) != o['app']:
            continue
        for e in TrackerFile(p).entries:
            if not KEY_RE.match(e.value('Jira') or ''):
                targets.append((p, e.id, None))
    return jira_for_entries(root, targets, dry, limit=limit)


def jira_parents(root, cfg, jira, o):
    """Reconcile each linked issue's epic with its entry's `Jira parent`.

    Only open epics of the project count as parents. Jira has an epic and the entry names
    none or a non-epic -> the entry takes Jira's. Jira has none -> set from the entry (or a
    rule). Both name different epics -> kept as is unless --force (tracker wins)."""
    dry, force = bool(o.get('dry-run')), bool(o.get('force'))
    epics = {k for k, _ in jira.epics()}
    c = {'set': 0, 'pulled': 0, 'same': 0, 'kept': 0, 'none': 0, 'failed': 0}
    for p in tracker_files(root):
        app = app_of(root, p, cfg)
        if o.get('app') and app != o['app']:
            continue
        tf = TrackerFile(p)
        dirty = False
        for e in tf.entries:
            key = e.value('Jira') or ''
            if not KEY_RE.match(key):
                continue
            want, how = jira.epic_for(e, app)
            if want and want not in epics:
                want, how = None, None  # a bundle, a story or a stale id: not an epic
            try:
                cur = jira.parent_of(key)
                cur = cur if cur in epics else None
                if cur and cur == want:
                    c['same'] += 1
                elif cur and (not want or how != 'entry'):
                    c['pulled'] += 1
                    print('pull  %s:%s %s epic %s from Jira' % (app, e.id, key, cur))
                    if not dry and e.value('Jira parent') != cur:
                        e.set(tf.kind, 'Jira parent', cur)
                        dirty = True
                elif cur and want and not force:
                    c['kept'] += 1
                    print('keep  %s:%s %s (Jira %s, tracker %s; --force to move)' % (app, e.id, key, cur, want))
                elif want:
                    c['set'] += 1
                    print('%s %s:%s %s -> %s' % ('would set' if dry else 'set  ', app, e.id, key, want))
                    if not dry:
                        jira.set_parent(key, want)
                        if e.value('Jira parent') != want:
                            e.set(tf.kind, 'Jira parent', want)
                            dirty = True
                else:
                    c['none'] += 1
                    print('none  %s:%s %s has no epic: `set %s "Jira parent" <epic>` (see `jira epics`)'
                          % (app, e.id, key, e.id))
                    if not dry and e.value('Jira parent'):
                        e.drop('Jira parent')
                        dirty = True
            except (JiraError, urllib.error.URLError) as ex:
                c['failed'] += 1
                print('FAILED %s:%s %s %s' % (app, e.id, key, ex))
        if dirty:
            tf.save()
    print('epics: %(set)d set, %(pulled)d taken from Jira, %(same)d already right, %(kept)d kept (differ), '
          '%(none)d without an epic, %(failed)d failed' % c)
    return 1 if c['failed'] else 0


def jira_configure(root, cfg, o):
    """Write the jira block of .cycle/tracker.json (mode, site, project, auth); keeps other keys."""
    mode = o.get('mode')
    if mode not in ('enforce', 'optional', 'off'):
        sys.exit('jira configure: --mode enforce|optional|off is required')
    cfg = dict(cfg)
    cfg['format'] = cfg.get('format', 2)
    if mode == 'off':
        if cfg.get('jira'):
            cfg['jira_disabled'] = cfg.pop('jira')  # kept so re-enabling restores the settings
    else:
        j = dict(cfg.get('jira') or cfg.pop('jira_disabled', None) or {})
        cfg.pop('jira_disabled', None)
        for opt, key in (('site', 'site'), ('project', 'project')):
            if o.get(opt):
                j[key] = o[opt].rstrip('/')
        if not j.get('site') or not j.get('project'):
            sys.exit('jira configure: --site and --project are required the first time')
        j['enforce'] = mode == 'enforce'
        types = dict(j.get('issueTypes') or {'bug': 'Bug', 'feature': 'Story'})
        if o.get('bug-type'):
            types['bug'] = o['bug-type']
        if o.get('feature-type'):
            types['feature'] = o['feature-type']
        j['issueTypes'] = types
        auth = dict(j.get('auth') or {})
        for opt, key in (('auth', 'type'), ('email-env', 'emailEnv'), ('token-env', 'tokenEnv')):
            if o.get(opt):
                auth[key] = o[opt]
        if auth:
            j['auth'] = auth
        j.setdefault('fields', {'externalId': None, 'acceptanceCriteria': None, 'testPlan': None})
        j.setdefault('components', False)
        order = ['site', 'project', 'enforce', 'issueTypes', 'auth', 'fields', 'components']
        cfg['jira'] = {k: j[k] for k in order if k in j}
        cfg['jira'].update({k: v for k, v in j.items() if k not in order})
    p = os.path.join(root, '.cycle', 'tracker.json')
    os.makedirs(os.path.dirname(p), exist_ok=True)
    write(p, json.dumps(cfg, indent=2) + '\n')
    _MODE.pop(root, None)
    print('jira mode: %s (.cycle/tracker.json)' % mode)
    if mode != 'off':
        print('next: python .cycle/trackers.py jira doctor')
    return 0


HINTS = [(r'steps to reproduce|\brepro', 'Repro / Notes'), (r'acceptance', 'Acceptance criteria'),
         (r'test plan|test strategy', 'Test plan'), (r'component|\barea', '@areas'),
         (r'observation|actual (result|behaviou?r)', 'Observation'), (r'expected', 'Expected'),
         (r'^files?\b|file\(s\)', 'File(s)'), (r'requirement', 'Req'), (r'approach|solution design', 'Approach'),
         (r'out of scope', 'Out of scope'), (r'^why\b|motivation|business value', 'Why')]


def _hint(name, kind):
    for rx, src in HINTS:
        if re.search(rx, name, re.I) and (src.startswith('@') or src in fields_of(kind)):
            return src
    return None


def jira_doctor(root, cfg, o=None):
    """Check credentials and the project's create screens; --write fills the field map."""
    o = o or {}
    jira = Jira(cfg)
    print('config      %s' % (os.path.join('.cycle', 'tracker.json') if cfg else 'MISSING .cycle/tracker.json'))
    print('mode        %s' % jira_mode(root))
    if jira_mode(root) == 'off':
        print('Jira is off for this repo; nothing to check')
        return 0
    print('site        %s' % (jira.site or 'MISSING'))
    print('project     %s' % (jira.project or 'MISSING'))
    print('auth        %s (%s)' % (jira.auth_type, 'Cloud email + API token' if jira.auth_type == 'basic' else 'Data Center personal access token'))
    if jira.auth_type == 'basic':
        print('%-11s %s' % (jira.email_env, 'set' if jira.email else 'MISSING'))
    print('%-11s %s' % (jira.token_env, 'set (%d chars)' % len(jira.token) if jira.token else 'MISSING'))
    if jira.missing():
        print('FAIL: set %s (see .cycle/TRACKERS-jira.md, "Jira setup")' % ', '.join(jira.missing()))
        return 1
    ok, changed = True, False
    j = dict(cfg.get('jira') or {})
    fields_cfg = dict(j.get('fields') or {})
    fmap_all = dict(fields_cfg.get('map') or {})
    tags = sorted({a.strip() for p in tracker_files(root) for e in TrackerFile(p).entries
                   for a in (e.value('Area') or '').split(',') if a.strip() and a.strip() != 'unknown'})
    try:
        me = jira.req('GET', '/rest/api/2/myself')
        print('auth        OK as %s' % me.get('displayName', '?'))
        proj = jira.req('GET', '/rest/api/2/project/%s' % urllib.parse.quote(jira.project))
        print('project     OK: %s' % proj.get('name'))
        for kind in ('bug', 'feature'):
            tname = jira.issue_type(kind)
            meta = jira.meta(kind)
            if not meta:
                print('issue type  %-8s NOT ON THE PROJECT\'S CREATE SCREEN' % tname)
                ok = False
                continue
            print('issue type  %-8s OK (%d fields on the create screen)' % (tname, len(meta)))
            ext = next((fid for fid, m in meta.items() if m['name'].strip().lower() == 'external id'), None)
            if ext and fields_cfg.get('externalId') != ext:
                print('            External ID is %s on this screen (config: %s)' % (ext, fields_cfg.get('externalId') or '-'))
                fields_cfg['externalId'] = ext
                changed = True
            kmap = dict(jira.field_map(kind))
            kmap.update(fmap_all.get(kind) or {})
            for fid, m in sorted(meta.items(), key=lambda x: (not x[1]['required'], x[1]['name'])):
                if fid in SYSTEM_FIELDS or fid == fields_cfg.get('externalId'):
                    continue
                have = kmap.get(fid)
                hint = None if have else _hint(m['name'], kind)
                if not (m['required'] or have or hint):
                    continue
                state = 'mapped from %s' % (have if isinstance(have, str) else (have or {}).get('from')) if have else (
                    'suggest %s' % hint if hint else 'UNMAPPED')
                print('  %-9s %-34s %-18s %s' % ('required' if m['required'] else 'optional', m['name'][:34], fid, state))
                if hint:
                    kmap[fid] = hint
                    changed = True
                if m['required'] and not (have or hint):
                    ok = False
                src = have if isinstance(have, str) else (have or {}).get('from') if have else hint
                if src == '@areas' and m['allowed']:
                    low = {a.lower() for a in m['allowed']}
                    miss = [t for t in tags if t.lower() not in low and not any(
                        w.strip().lower() in low for w in re.split(r'[/()]', t))]
                    print('            allowed: %s' % ', '.join(m['allowed'][:30]))
                    if miss:
                        print('            %d Area tags match no option (%s%s): they are dropped; an entry with none'
                              ' left needs a "default" or "valueMap" (TRACKERS-jira.md, "Field map")' % (
                                  len(miss), ', '.join(miss[:12]), ', …' if len(miss) > 12 else ''))
            fmap_all[kind] = kmap
        wok, wchanged, wfl = doctor_workflow(jira, j, o.get('write'))
        ok = ok and wok
        if wchanged:
            j['workflow'] = wfl
            changed = True
        if j.get('worklog') != 'off':
            tt = (jira.req('GET', '/rest/api/2/configuration') or {}).get('timeTrackingEnabled')
            print('worklogs    %s' % ('time tracking on (opt-in per person: TRACKERS-worklogs.md)' if tt else
                                      'time tracking OFF on the site: worklogs cannot post (a Jira admin turns it on)'))
        doctor_epics(jira)
        bl = doctor_bundles(jira, j, fmap_all)
        if bl and bl != j.get('bundles'):
            j['bundles'] = bl
            changed = True
    except (JiraError, urllib.error.URLError) as ex:
        print('FAIL: %s' % ex)
        return 1
    if changed and o.get('write'):
        fields_cfg['map'] = fmap_all
        j['fields'] = fields_cfg
        cfg = dict(cfg)
        cfg['jira'] = j
        write(os.path.join(root, '.cycle', 'tracker.json'), json.dumps(cfg, indent=2) + '\n')
        print('wrote the suggestions to .cycle/tracker.json (jira.fields, jira.workflow); review and commit it')
    elif changed:
        print('re-run with --write to save the suggestions to .cycle/tracker.json')
    print('doctor: %s' % ('OK' if ok and not (changed and not o.get('write')) else 'issues above'))
    return 0 if ok else 1

# ---------------------------------------------------------------- adopt + schema lint + hook

def adopt_file(path, root, report):
    kind = kind_of(path)
    text = read(path)
    h1 = next((l for l in text.split('\n') if l.startswith('# ')), '# %s' % os.path.basename(path))
    entries, removed, section = [], [], ''
    for c in split_blocks(text):
        if c.startswith('## '):
            section = c.split('\n')[0]
            continue
        if not c.startswith('### ['):
            continue
        c = re.sub(r'(?m)^---\s*\n?', '', c)
        e = parse_entry(c)
        st = e.status() or ''
        archive = bool(re.search(r'shipped|migrated|archive|released|closed', section, re.I))
        if st and CLOSED_RE.search(st) and not st.endswith('pending-migration') or (not st and archive):
            removed.append((e.id, st or 'archived', e.value('Jira') or ''))
            continue
        adopt_entry(e, kind, report['manual'])
        entries.append(e)
    seen, uniq = set(), []
    for e in entries:
        if e.id in seen:
            report['manual'].append('%s: duplicate active copy in %s; second copy dropped' % (e.id, path))
            continue
        seen.add(e.id)
        uniq.append(e)
    rel_fmt = rel_or_abs(os.path.join(root, '.cycle', 'TRACKERS.md'), os.path.dirname(path)).replace('\\', '/')
    pre = ('%s\n\nActive work only. Format and rules: [`.cycle/TRACKERS.md`](%s). Write with '
           '`python .cycle/trackers.py`, never by hand. Shipped and closed entries are removed; '
           'their record is `CHANGELOG.md`, Jira, and `python .cycle/trackers.py show <id>`.\n') % (h1, rel_fmt)
    out = pre + '\n## Open\n\n' + '\n'.join(e.render() for e in uniq)
    rel = rel_or_abs(path, root)
    # conservation: every column-0 entry heading in the input is active or removed, and the output
    # re-splits into exactly the active entries (an unclosed fence would swallow the rest silently)
    got = {e.id for e in entries} | {r[0] for r in removed}
    for eid in dict.fromkeys(re.findall(r'(?m)^### \[((?:BUG|FEAT)-\d+[a-z]*)\]', text)):
        if eid not in got:
            report['lost'].append((rel, eid, 'inside a fenced block or another entry'))
    n_out = sum(1 for c in split_blocks(out) if c.startswith('### ['))
    if n_out != len(uniq):
        report['lost'].append((rel, '-', 'output re-splits into %d entries, %d written' % (n_out, len(uniq))))
    report['files'].append((rel, len(text), len(out), len(uniq), len(removed)))
    report['removed'] += [(rel_or_abs(path, root),) + r for r in removed]
    return out


def cmd_adopt(argv):
    """adopt [PATH...] [--dry-run] [--report FILE] [--accept-missing ID,ID] [--no-jira]: convert legacy
    trackers to format 2. Writes nothing when an entry would vanish; closes removed entries' Jira issues."""
    o, pos = opts(argv, flags=('dry-run', 'no-jira'))
    root = repo_root()
    paths = [os.path.abspath(p) for p in pos] or tracker_files(root)
    report = {'files': [], 'removed': [], 'manual': [], 'lost': []}
    outs = [(p, adopt_file(p, root, report)) for p in paths]
    ok_ids = set(filter(None, (o.get('accept-missing') or '').split(',')))
    lost = [x for x in report['lost'] if x[1] not in ok_ids]
    if lost:
        print('adopt: refused, nothing written: %d entr%s would vanish' % (len(lost), 'y' if len(lost) == 1 else 'ies'))
        for f, eid, why in lost:
            print('  %s %s: %s' % (f, eid, why))
        print('Usual cause: a line starting with ``` or ~~~ that opens a code block and never closes. Fix it in the\n'
              'legacy file and re-run. An id that is only an example inside a code block: --accept-missing %s'
              % ','.join(x[1] for x in lost if x[1] != '-'))
        return 1
    for p, out in outs:
        if not o.get('dry-run'):
            write(p, out)
    cfgp = os.path.join(root, '.cycle', 'tracker.json')
    if not o.get('dry-run'):
        cfg = load_config(root)
        if cfg.get('format') != 2:
            cfg['format'] = 2
            os.makedirs(os.path.dirname(cfgp), exist_ok=True)
            write(cfgp, json.dumps(cfg, indent=2) + '\n')
    lines = ['# Tracker adoption report (%s)' % today(), '',
             '| tracker | bytes before | bytes after | active | removed |', '|---|---:|---:|---:|---:|']
    for f, b, a, n, r in report['files']:
        lines.append('| %s | %d | %d | %d | %d |' % (f, b, a, n, r))
    lines += ['', '## Removed (shipped or closed; recoverable with `trackers.py show <id>`)', '',
              '| tracker | id | status | Jira |', '|---|---|---|---|']
    lines += ['| %s | %s | %s | %s |' % r for r in report['removed']]
    lines += ['', '## Needs a hand decision', ''] + ['- ' + m for m in report['manual']] + ['']
    text = '\n'.join(lines)
    if o.get('report'):
        write(o['report'], text)
    tb = sum(f[1] for f in report['files'])
    ta = sum(f[2] for f in report['files'])
    print('adopt: %d files, %d KB -> %d KB, %d active, %d removed, %d hand decisions%s' % (
        len(report['files']), tb // 1024, ta // 1024, sum(f[3] for f in report['files']),
        len(report['removed']), len(report['manual']), ' (dry run)' if o.get('dry-run') else ''))
    pairs = [(r[3], r[2]) for r in report['removed'] if KEY_RE.match(r[3] or '')]
    if not pairs:
        return 0
    jira = None if o.get('no-jira') else jira_or_none(root)
    if jira:
        pairs = [x for x in pairs if x[0].startswith(jira.project + '-')]
    if not jira or not pairs:
        if pairs:
            print('%d removed entries have Jira issues; close them: python .cycle/trackers.py jira done %s'
                  % (len(pairs), ' '.join(k for k, _ in pairs)))
        return 0
    print('adopt: %d removed entries have Jira issues%s' % (len(pairs), ' (dry run)' if o.get('dry-run') else ''))
    wf = fit_workflow(jira, workflow(load_config(root)))
    return 1 if done_keys(jira, wf, pairs, o.get('dry-run')) else 0


def schema_lint(path, fix):
    """Format-2 checks for one tracker. Returns (errors, warnings) as (line, code, id, msg)."""
    kind = kind_of(path)
    if not kind:
        return [], []
    text = read(path)
    errs, warns = [], []
    fence = None
    for n, l in enumerate(text.split('\n'), 1):
        m = NESTED_RE.match(l) if fence is None else None
        if m:
            errs.append((n, 'NESTED', m.group(1), 'entry heading indented inside another entry (a bad `adopt`): '
                         'restore the pre-adopt file and re-run `adopt`'))
        fence = fence_step(fence, l)
    heads = [l for l in text.split('\n') if l.startswith('## ')]
    if heads != ['## Open']:
        errs.append((1, 'SECTION', '-', 'only one `## Open` section allowed, found %s (run `adopt`)' % (heads or 'none')))
        fix = False  # never reshape a legacy file entry by entry; `adopt` converts it whole
    tf = TrackerFile(path)
    lineno = {}
    for n, l in enumerate(text.split('\n'), 1):
        m = HEAD_RE.match(l) or re.match(r'^### \[([^\]]+)\]', l)
        if m:
            lineno.setdefault(m.group(1), n)
    changed = False
    frozen = changelog_sections([os.path.join(os.path.dirname(os.path.abspath(path)), 'CHANGELOG.md')])
    for e in tf.entries:
        tg = (e.value('Target') or '').lstrip('v')
        if tg in frozen:
            warns.append((lineno.get(e.id, 0), 'STALE-TARGET', e.id, 'Target v%s is already released (CHANGELOG); '
                          '`set %s Target <next>|unscheduled`' % (tg, e.id)))
        if fix:
            before = e.render()
            fix_entry(e, kind)
            changed = changed or e.render() != before
        for code, sev, msg in lint_entry(e, kind):
            (errs if sev == 'E' else warns).append((lineno.get(e.id, 0), code, e.id, msg))
    if fix and (changed or tf.render() != text):
        tf.save()
        warns.append((0, 'FIXED', '-', 'mechanical fixes applied'))
    return errs, warns


def cmd_hook(argv):
    """Claude Code PreToolUse hook: block hand edits of format-2 trackers."""
    try:
        ev = json.load(sys.stdin)
    except ValueError:
        return 0
    ti = ev.get('tool_input') or {}
    p = ti.get('file_path') or ti.get('notebook_path') or ''
    if ev.get('tool_name') in ('Edit', 'Write', 'MultiEdit') and os.path.basename(p) in TRACKER_FILES:
        sys.stderr.write(
            'Hand edits of %s are blocked. Use the tracker tool instead:\n'
            '  python .cycle/trackers.py add --tracker %s --json -     (new entry; JSON on stdin)\n'
            '  python .cycle/trackers.py set <ID> "<Field>" <value>     (change a field; - reads stdin)\n'
            '  python .cycle/trackers.py log <ID> "<text>"              (dated note)\n'
            '  python .cycle/trackers.py migrate <ID> | close <ID> --reason <r>\n'
            'Format: .cycle/TRACKERS.md\n' % (os.path.basename(p), p))
        return 2
    return 0


GUARD_IMPORT = re.compile(r'\b(?:import\s+(?:tracker_ops|worklog)\b|from\s+(?:tracker_ops|worklog)\s+import|(?:tracker_ops|worklog)\s+as\b)')
GUARD_API = re.compile(r'/rest/(?:api/[23]|agile/1\.0)/')
GUARD_NET = re.compile(r'\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|requests|urllib|http\.client|httpx|fetch|aiohttp|axios)\b', re.I)
GUARD_OWN = ('trackers.py', 'tracker_ops.py', 'worklog.py', 'worklog_time.py', 'bundle_check.py')
# CI/CD (F26): pipelines cost money, so Claude reads finished results only through local-gate's
# read-only ci_evidence.py and never triggers, re-runs, cancels or reconfigures CI. git push is not
# covered: pushing is how the team runs CI on purpose.
CI_CLI = re.compile(r'(?:^|[;&|(`\s])(?:gh\s+(?:api|workflow|run|secret|variable|cache|ruleset)'
                    r'|glab\s+(?:api|ci|job|pipeline|schedule|variable)'
                    r'|aws\s+(?:codebuild|codepipeline)\s+(?:start|retry|stop|update|delete|create|put)'
                    r'|az\s+pipelines\s+(?:run|update|delete|create|variable))\b')
CI_API = re.compile(r'api\.bitbucket\.org|api\.github\.com|/api/v4/projects\b|/repos/[^\s/]+/[^\s/]+/actions\b'
                    r'|/rest/(?:api/(?:1\.0|latest)/projects|build-status/1\.0)/|/2\.0/repositories/'
                    r'|circleci\.com/api|/job/[^\s/]+/build(?:WithParameters)?\b', re.I)
CI_IMPORT = re.compile(r'\b(?:import\s+ci_evidence\b|from\s+ci_evidence\s+import|ci_evidence\s+as\b)')
CI_OWN = 'ci_evidence.py'


GIT_LEAD = re.compile(r'\s*(?:cd\s+(?:"[^"]*"|\S+)\s*&&\s*)?git\s')


def ci_guard_reason(text, command=False):
    """Why TEXT reaches a CI/CD service outside local-gate's ci_evidence.py, or None. A git command
    (commit, push) is checked for API calls only, so a commit message naming `gh run` passes."""
    if CI_IMPORT.search(text):
        return 'imports ci_evidence instead of running it'
    m = None if command and GIT_LEAD.match(text) else CI_CLI.search(text)
    if m:
        return 'runs `%s`' % m.group(0).strip(' ;&|(`')
    if GUARD_NET.search(text) and CI_API.search(text):
        return 'calls a CI/CD API'
    return None


def _ci_own(path):
    """The sanctioned reader: ci_evidence.py inside an installed local-gate skill."""
    norm = path.replace('\\', '/')
    return os.path.basename(norm) == CI_OWN and '/local-gate/scripts/' in norm


def jira_guard_reason(text, hosts):
    """Why TEXT reaches Jira outside trackers.py, or None."""
    if GUARD_IMPORT.search(text):
        return 'imports the tracker internals'
    if not GUARD_NET.search(text):
        return None
    if any(h in text for h in hosts):
        return 'calls the Jira site'
    if GUARD_API.search(text) and not re.search(r'\b(?:localhost|127\.0\.0\.1)\b', text):
        return 'calls a Jira REST path'
    return None


def cmd_jira_guard(argv):
    """Claude Code PreToolUse hook (Bash), also `api-guard`: Jira is reached only through trackers.py, CI/CD
    only through local-gate's read-only ci_evidence.py. Blocks a command, or a script file it runs, that
    imports the internals or calls either API. CYCLE_JIRA_GUARD=off / CYCLE_CI_GUARD=off disable one half
    (set in the hook's environment by the user, never inline in the command)."""
    jira_on = os.environ.get('CYCLE_JIRA_GUARD') != 'off'
    ci_on = os.environ.get('CYCLE_CI_GUARD') != 'off'
    if not (jira_on or ci_on):
        return 0
    try:
        ev = json.load(sys.stdin)
    except ValueError:
        return 0
    cmd = (ev.get('tool_input') or {}).get('command') or ''
    if ev.get('tool_name') != 'Bash' or not cmd:
        return 0
    root = os.environ.get('CLAUDE_PROJECT_DIR') or ev.get('cwd') or os.getcwd()
    hosts = {'atlassian.net'}
    try:
        site = urllib.parse.urlparse((load_config(root).get('jira') or {}).get('site') or '').hostname
        if site:
            hosts.add(site)
    except Exception:
        pass
    def reasons(text, command=False):
        """(kind, why) for the first guard TEXT trips."""
        if jira_on:
            w = jira_guard_reason(text, hosts)
            if w:
                return 'jira', w
        if ci_on:
            w = ci_guard_reason(text, command)
            if w:
                return 'ci', w
        return None, None

    kind, why = reasons(cmd, command=True)
    for tok in re.findall(r'[\w./\\:~-]+\.(?:py|sh|ps1|js|mjs|cjs|ts)\b', cmd):
        if why:
            break
        p = os.path.join(ev.get('cwd') or root, os.path.expanduser(tok))
        if os.path.basename(p) in GUARD_OWN or _ci_own(p) or not os.path.isfile(p):
            continue
        try:
            body = open(p, encoding='utf-8', errors='replace').read(200000)
        except OSError:
            continue
        kind, r = reasons(body)
        why = r and '%s (%s)' % (r, tok)
    if not why:
        return 0
    if kind == 'ci':
        sys.stderr.write(
            'Blocked: this command %s. CI/CD is read only through local-gate\'s read-only script:\n'
            '  python <local-gate>/scripts/ci_evidence.py --sha <sha> --jobs "<CI job>,..."\n'
            'Triggering, re-running or cancelling pipelines, and changing CI variables, schedules or settings,\n'
            'is left to the user (it costs money). Commits and pushes are not affected. If the script cannot\n'
            'answer what is needed, stop and tell the user; do not script around it.\n' % why)
        return 2
    sys.stderr.write(
        'Blocked: this command %s. Jira is read and written only through `python .cycle/trackers.py`\n'
        '(.cycle/TRACKERS-jira.md): set, jira sync|status|done|release|versions, jira version add|edit|renumber|release, plan.\n'
        'If no command does what is needed, stop and tell the user which command is missing; do not script around it.\n' % why)
    return 2


BRANCH_MAX = 60  # Bitbucket Data Center: 100 for refs/heads/<name> (89 for the name); Cloud: no documented limit
STOP = {'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'when', 'is', 'are', 'be', 'by', 'from', 'at', 'as'}


def branch_name(kind, key, title, maxlen=BRANCH_MAX, btype=None):
    """<feature|bugfix|hotfix>/<KEY>-<slug>: KEY is the issue key in this project's own Jira (else the
    tracker id); lowercase ASCII words, stop words dropped, cut at a word so the name fits MAXLEN."""
    import unicodedata
    prefix = '%s/%s' % (btype or ('bugfix' if kind == 'bug' else 'feature'), key)
    words = re.findall(r'[a-z0-9]+', unicodedata.normalize('NFKD', title).encode('ascii', 'ignore').decode().lower())
    words = [w for w in words if w not in STOP] or words
    slug = ''
    for w in words:
        nxt = (slug + '-' + w) if slug else w
        if len(prefix) + 1 + len(nxt) > maxlen:
            break
        slug = nxt
    if not slug and words:
        slug = words[0][:max(0, maxlen - len(prefix) - 1)]
    return (prefix + '-' + slug) if slug else prefix


def cmd_branch(argv):
    """branch ID [ID...] [--type feature|bugfix|hotfix|bundle] [--slug TEXT] [--max N] [--app A]"""
    o, pos = opts(argv)
    if not pos or o.get('type') not in (None, 'feature', 'bugfix', 'hotfix', 'bundle'):
        sys.exit('usage: branch ID [ID...] [--type feature|bugfix|hotfix|bundle] [--slug "short summary"] [--max N]')
    root = repo_root()
    found = [locate(root, i, None, o.get('app')) for i in pos]
    kinds = [tf.kind for tf, _ in found]
    kind = 'feature' if 'feature' in kinds else 'bug'
    tf, e = found[0]
    key = e.value('Bundle' if o.get('type') == 'bundle' else 'Jira') or ''
    if not KEY_RE.match(key):
        key = e.id  # no issue (or bundle) yet: rename the branch once it exists
    print(branch_name(kind, key, o.get('slug') or e.title, int(o.get('max') or BRANCH_MAX), o.get('type')))
    return 0



# ---------------------------------------------------------------- bundles (batchable clusters in Jira)

def bundle_members(root, bkey):
    """[(tracker path, entry)] for the entries whose `Bundle:` is BKEY, across every tracker."""
    return [(p, e) for p in tracker_files(root) for e in TrackerFile(p).entries if (e.value('Bundle') or '') == bkey]


def bundle_follow(root, jira, wf, bkey):
    """Keep bundle BKEY level with its members: the least-advanced member's board target, Done
    once no member is left in the trackers. Forward only. True when the board matches."""
    members = bundle_members(root, bkey)
    if not members:
        return jira_move(jira, bkey, wf['done'], wf)
    sts = [e.status() for _, e in members]
    if all(s.endswith('pending-migration') for s in sts):
        target = wf['review']
    elif all(s != 'open' for s in sts):
        target = wf['inProgress']
    else:
        target = None
    return jira_move(jira, bkey, target, wf) if target else True


def bundle_fields(jira, summary, members, root, cfg):
    """Create-issue fields for a bundle Task: label cycle-bundle, members listed, shared epic."""
    lines = ['Bundle: tickets implemented together on one branch (/implement-batch).',
             'Each member is linked "%s" from this issue and moves across the board with it.' % jira.link_type(), '',
             '*Members*']
    epics = set()
    for p, e in members:
        lines.append('* %s %s (%s)' % (e.value('Jira'), e.title, e.id))
        epics.add(jira.epic_for(e, app_of(root, p, cfg))[0])
    title = 'Bundle: ' + summary
    f = {'project': {'key': jira.project}, 'issuetype': {'name': jira.issue_type('bundle')},
         'summary': title if len(title) <= 255 else title[:252] + '...',
         'description': '\n'.join(lines), 'labels': [BUNDLE_LABEL]}
    if len(epics) == 1 and None not in epics:
        fld = (jira.cfg.get('epics') or {}).get('field', 'parent')
        f[fld] = {'key': epics.pop()} if fld == 'parent' else epics.pop()
    fmap = jira.field_map('bundle')  # literals only: a bundle has no tracker entry ("=value", @title)
    if fmap:
        try:
            meta = jira.meta('bundle')
        except NET_ERRORS:
            meta = {}
        pseudo = Entry('BUNDLE', summary)
        for fid, spec in fmap.items():
            spec = {'from': spec} if isinstance(spec, str) else spec
            v = _convert(_source(pseudo, '', spec['from']), spec, meta.get(fid))
            if v is not None:
                f[fid] = v
    return f


def _bundle_jira(root, verb):
    jira = jira_or_none(root)
    if not jira:
        sys.exit('bundle %s: needs Jira (mode enforce or optional, with credentials: `jira doctor`)' % verb)
    return jira, fit_workflow(jira, workflow(load_config(root)))


def _keyed(root, ids, app):
    """Locate IDS; create missing Jira issues first. Returns [(path, entry)]."""
    found = [(tf.path, e) for tf, e in (locate(root, i, None, app) for i in ids)]
    missing = [(p, e.id) for p, e in found if not KEY_RE.match(e.value('Jira') or '')]
    if missing:
        jira_for_entries(root, missing, dry=False)
        found = [(tf.path, e) for tf, e in (locate(root, i, None, app) for i in ids)]
    still = [e.id for _, e in found if not KEY_RE.match(e.value('Jira') or '')]
    if still:
        sys.exit('bundle: no Jira issue for %s (`jira sync --dry-run` says why)' % ', '.join(still))
    return found


def _join(jira, bkey, members):
    for p, e in members:
        print('  %s: %s %s' % (e.value('Jira'), jira.link(bkey, e.value('Jira')), bkey))
        tf = TrackerFile(p)
        cur = tf.get(e.id)
        cur.set(tf.kind, 'Bundle', bkey)
        fix_entry(cur, tf.kind)
        check_or_die(cur, tf.kind)
        tf.save()


def cmd_bundle(argv):
    """bundle create ID ID... --summary S | add BKEY ID... | remove ID... | sync BKEY   [--app A] [--dry-run]"""
    usage = ('usage: bundle create ID ID... --summary "short summary" [--dry-run] | bundle add BKEY ID... |\n'
             '       bundle remove ID... | bundle sync BKEY      (all take --app A)')
    if not argv or argv[0] not in ('create', 'add', 'remove', 'sync'):
        sys.exit(usage)
    sub = argv[0]
    o, pos = opts(argv[1:], flags=('dry-run',))
    root = repo_root()
    cfg = load_config(root)
    if sub == 'create':
        if len(pos) < 2 or not o.get('summary'):
            sys.exit('bundle create: two or more ids and --summary are required (one ticket: /implement)')
        if o.get('dry-run'):
            found = [(tf.path, e) for tf, e in (locate(root, i, None, o.get('app')) for i in pos)]
            for p, e in found:
                print('member %-18s %-10s %s' % (e.id, e.value('Jira') or 'pending', e.title))
            print('bundle "Bundle: %s" (%s, label %s); branch %s' % (
                o['summary'], ISSUE_TYPES['bundle'], BUNDLE_LABEL,
                branch_name('bug', '<KEY>', o['summary'], btype='bundle')))
            return 0
        jira, wf = _bundle_jira(root, 'create')
        members = _keyed(root, pos, o.get('app'))
        other = ['%s (in %s)' % (e.id, e.value('Bundle')) for _, e in members if e.value('Bundle')]
        if other:
            sys.exit('bundle create: already bundled: %s; `bundle remove` them first' % ', '.join(other))
        try:
            bkey = jira.create(bundle_fields(jira, o['summary'], members, root, cfg))
            print('created bundle %s "%s"' % (bkey, o['summary']))
            _join(jira, bkey, members)
        except NET_ERRORS as ex:
            sys.exit('bundle create: %s (`jira doctor` checks the %s type and the "%s" link type)' % (
                ex, jira.issue_type('bundle'), jira.link_type()))
        bundle_follow(root, jira, wf, bkey)
        print('branch: %s' % branch_name('bug', bkey, o['summary'], btype='bundle'))
        return 0
    if sub == 'add':
        if len(pos) < 2 or not KEY_RE.match(pos[0]):
            sys.exit(usage)
        jira, wf = _bundle_jira(root, 'add')
        members = _keyed(root, pos[1:], o.get('app'))
        other = ['%s (in %s)' % (e.id, e.value('Bundle')) for _, e in members if e.value('Bundle') not in (None, pos[0])]
        if other:
            sys.exit('bundle add: already bundled: %s; `bundle remove` them first' % ', '.join(other))
        try:
            _join(jira, pos[0], members)
        except NET_ERRORS as ex:
            sys.exit('bundle add: %s' % ex)
        bundle_follow(root, jira, wf, pos[0])
        return 0
    if sub == 'remove':
        if not pos:
            sys.exit(usage)
        jira = jira_or_none(root)
        touched = set()
        for eid in pos:
            tf, e = locate(root, eid, None, o.get('app'))
            b = e.value('Bundle')
            if not b:
                print('%s: not in a bundle' % eid)
                continue
            if jira and KEY_RE.match(e.value('Jira') or ''):
                try:
                    print('  %s: %d link(s) to %s removed' % (e.value('Jira'), jira.unlink(b, e.value('Jira')), b))
                except NET_ERRORS as ex:
                    print('  warning: unlink %s from %s in Jira by hand: %s' % (e.value('Jira'), b, ex))
            elif not jira:
                print('  unlink %s from %s in Jira by hand (Jira off or no credentials)' % (e.value('Jira'), b))
            e.drop('Bundle')
            tf.save()
            touched.add(b)
            print('%s: removed from bundle %s' % (eid, b))
        if jira:
            wf = fit_workflow(jira, workflow(cfg))
            for b in sorted(touched):
                if bundle_members(root, b):
                    bundle_follow(root, jira, wf, b)
                else:
                    print('bundle %s has no members left: close it in Jira' % b)
        return 0
    if len(pos) != 1 or not KEY_RE.match(pos[0]):
        sys.exit(usage)
    jira, wf = _bundle_jira(root, 'sync')
    n = len(bundle_members(root, pos[0]))
    print('bundle %s: %d member(s) in the trackers' % (pos[0], n))
    if not n:  # it would go to Done: make sure it is a bundle
        try:
            labels = jira.req('GET', '/rest/api/2/issue/%s?fields=labels' % pos[0])['fields'].get('labels') or []
        except NET_ERRORS as ex:
            sys.exit('bundle sync: %s' % ex)
        if BUNDLE_LABEL not in labels:
            sys.exit('bundle sync: %s has no label %s; not a bundle, left alone' % (pos[0], BUNDLE_LABEL))
    return 0 if bundle_follow(root, jira, wf, pos[0]) else 1


def epic_fields(jira, name, scope, reqs):
    """Create-issue fields for an epic: summary = NAME; the description states its scope and the
    requirement ids it groups, which is what later grooming matches tickets against. Data Center's
    required Epic Name field gets NAME; other required fields come from jira.fields.map.epic literals."""
    lines = ['Scope: %s' % scope] if scope else []
    if reqs:
        lines.append('Requirements: %s' % reqs)
    lines.append('Created by trackers.py jira epic add.')
    f = {'project': {'key': jira.project}, 'issuetype': {'name': jira.issue_type('epic')},
         'summary': name if len(name) <= 255 else name[:252] + '...', 'description': '\n'.join(lines)}
    try:
        meta = jira.meta('epic')
    except NET_ERRORS:
        meta = {}
    for fid, m in meta.items():
        if m['name'].lower() == 'epic name':
            f[fid] = name[:255]
    pseudo = Entry('EPIC', name)
    for fid, spec in jira.field_map('epic').items():
        spec = {'from': spec} if isinstance(spec, str) else spec
        v = _convert(_source(pseudo, '', spec['from']), spec, meta.get(fid))
        if v is not None:
            f[fid] = v
    return f


def plain_text(v):
    """A description as text: v2 returns wiki text; Cloud's v3 search returns an ADF document."""
    if v is None:
        return ''
    if isinstance(v, str):
        return v
    out = []

    def walk(n):
        if isinstance(n, dict):
            if n.get('type') == 'text':
                out.append(n.get('text', ''))
            for c in n.get('content') or []:
                walk(c)
            if n.get('type') in ('paragraph', 'heading', 'listItem'):
                out.append('\n')
        elif isinstance(n, list):
            for c in n:
                walk(c)
    walk(v)
    return re.sub(r'\n{2,}', '\n', ''.join(out)).strip()


def norm_name(t):
    return re.sub(r'\s+', ' ', (t or '').strip().lower())


def jira_epic(root, o, pos):
    """jira epic add NAME [--scope TEXT] [--req IDS] [--dry-run] [--json]: create an epic, or reuse the
    open epic that already has this name (case and spacing ignored). Prints the key."""
    if len(pos) < 2 or pos[0] != 'add' or not pos[1].strip():
        sys.exit('usage: jira epic add "NAME" [--scope "what it covers"] [--req FR-001,FR-002] [--dry-run] [--json]')
    name = re.sub(r'\s+', ' ', pos[1].strip())
    jira = jira_or_none(root)
    if not jira:
        sys.exit('jira epic add: Jira is off or credentials are missing (jira doctor)')
    try:
        same = [(k, s_) for k, s_ in jira.epics() if norm_name(s_) == norm_name(name)]
        if same:
            key, made, name = same[0][0], False, same[0][1]
        elif o.get('dry-run'):
            key, made = None, True
        else:
            key, made = jira.create(epic_fields(jira, name, o.get('scope'), o.get('req'))), True
    except NET_ERRORS as ex:
        sys.exit('jira epic add: %s (`jira doctor` checks the %s type)' % (ex, jira.issue_type('epic')))
    if o.get('json'):
        print(json.dumps({'key': key, 'name': name, 'created': made and not o.get('dry-run'),
                          'dry_run': bool(o.get('dry-run'))}))
    elif not made:
        print('exists %s "%s" (reused; no new epic)' % (key, same[0][1]))
    elif o.get('dry-run'):
        print('would create epic "%s"%s (dry run)' % (name, ' - %s' % o['scope'] if o.get('scope') else ''))
    else:
        print('created %s "%s"' % (key, name))
    return 0


def doctor_epics(jira):
    """The epic type can be created (required fields covered)."""
    tname = jira.issue_type('epic')
    try:
        meta = jira.meta('epic')
    except JiraError:
        meta = {}
    if not meta:
        print('epic type   %-8s NOT ON THE PROJECT\'S CREATE SCREEN (set jira.issueTypes.epic; `jira epic add` cannot create epics)' % tname)
        return
    fmap = jira.field_map('epic')
    need = [m['name'] for fid, m in meta.items() if m['required'] and fid not in SYSTEM_FIELDS
            and m['name'].lower() != 'epic name' and fid not in fmap]
    print('epic type   %-8s OK%s' % (tname, '' if not need else '; required with no value: %s '
          '(add literals in jira.fields.map.epic, e.g. {"<field id>": "=<value>"})' % ', '.join(need)))


def doctor_bundles(jira, j, fmap_all):
    """Bundle Task type and link type. Returns the jira.bundles block to save, or None."""
    tname = jira.issue_type('bundle')
    try:
        meta = jira.meta('bundle')
    except JiraError:
        meta = {}
    fmap = fmap_all.get('bundle') or jira.field_map('bundle')
    if not meta:
        print('bundle type %-8s NOT ON THE PROJECT\'S CREATE SCREEN (set jira.issueTypes.bundle)' % tname)
    else:
        need = [m['name'] for fid, m in meta.items() if m['required'] and fid not in SYSTEM_FIELDS
                and fid != (j.get('fields') or {}).get('externalId') and fid not in fmap]
        print('bundle type %-8s OK%s' % (tname, '' if not need else '; required with no value: %s '
              '(add literals in jira.fields.map.bundle, e.g. {"<field id>": "=<value>"})' % ', '.join(need)))
    want = jira.link_type()
    try:
        lts = jira.req('GET', '/rest/api/2/issueLinkType').get('issueLinkTypes', [])
    except JiraError as ex:
        print('link type   cannot list link types: %s' % ex)
        return None
    lt = next((t for t in lts if t.get('name', '').lower() == want.lower()), None) or \
        next((t for t in lts if t.get('outward', '').lower() == 'implements'), None)
    if not lt:
        print('link type   "%s" MISSING: bundles cannot be linked. Jira settings > Issues > Issue linking: '
              'add name "%s", outward "implements", inward "is implemented by"' % (want, want))
        return None
    print('link type   %s (outward "%s", inward "%s") OK' % (lt['name'], lt.get('outward'), lt.get('inward')))
    return dict(j.get('bundles') or {}, link=lt['name'])


# ---------------------------------------------------------------- commit messages (git commit-msg hook)

COMMIT_EXEMPT = ('main', 'master', 'trunk', 'release/*')
BRANCH_KEY_RE = re.compile(r'(?:^|/)([A-Z][A-Z0-9]+-\d+)(?=-|/|$)')
PASS_RE = re.compile(r'^(?:(?:fixup|squash|amend)! |Merge |Revert ")')


def branch_key(branch, project=None):
    """(key, tracker id) the branch is named for: <type>/<KEY>-<summary>. A tracker id in the key
    slot (no issue yet) comes back as the second value."""
    m = BRANCH_KEY_RE.search(branch or '')
    if not m:
        return None, None
    k = m.group(1)
    if re.match(r'(BUG|FEAT)-\d+$', k) and k.split('-')[0] != project:
        return None, k
    return k, None


def _commit_lines(path, cc):
    lines = []
    for l in read(path).split('\n'):
        if l.startswith(cc + ' ------------------------ >8 ------------------------'):
            break
        if l.startswith(cc):
            continue
        lines.append(l.rstrip())
    while lines and not lines[0]:
        lines.pop(0)
    while lines and not lines[-1]:
        lines.pop()
    return lines


def cmd_commit_msg(argv):
    """commit-msg FILE: the git commit-msg hook. Jira `enforce` only: on a work branch, line 1 is
    the branch's Jira key, then a blank line, then the message (TRACKERS.md, "Branches and
    commits"). Trunk and release branches, detached HEAD, merges, fixups and reverts pass."""
    if not argv:
        return 0
    root = repo_root()
    if jira_mode(root) != 'enforce':
        return 0
    branch = git('symbolic-ref', '--quiet', '--short', 'HEAD', cwd=root)
    if not branch:
        return 0
    j = load_config(root).get('jira') or {}
    exempt = list((j.get('commits') or {}).get('exempt') or COMMIT_EXEMPT)
    default = git('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD', cwd=root)
    if default:
        exempt.append(default.split('/', 1)[-1])
    if any(fnmatch.fnmatchcase(branch, p) for p in exempt):
        return 0
    gd = git('rev-parse', '--git-dir', cwd=root) or '.git'
    if os.path.exists(os.path.join(root, gd, 'MERGE_HEAD')):
        return 0
    cc = git('config', '--get', 'core.commentChar', cwd=root) or '#'
    lines = _commit_lines(argv[0], cc if cc != 'auto' else '#')
    if not lines or PASS_RE.match(lines[0]):
        return 0  # empty: git aborts the commit itself
    key, tid = branch_key(branch, j.get('project'))
    if tid:
        why = ('branch "%s" is still named for tracker id %s. Create its issue and rename the branch:\n'
               '  python .cycle/trackers.py jira sync\n'
               '  git branch -m "$(python .cycle/trackers.py branch %s)"' % (branch, tid, tid))
    elif not key:
        why = ('branch "%s" carries no Jira key. Work happens on a branch named for its issue:\n'
               '  git branch -m "$(python .cycle/trackers.py branch <ID>)"   (or <type>/<KEY>-<summary>)' % branch)
    elif lines[0].strip() != key:
        why = 'line 1 must be the branch\'s Jira key, exactly "%s" (got "%s")' % (key, lines[0][:60])
    elif len(lines) < 3 or lines[1] or not lines[2].strip():
        why = 'line 2 must be blank and line 3 must start the message'
    else:
        return 0
    k = key or 'PROJ-123'
    sys.stderr.write('commit refused (Jira enforce): %s\n\nForm (.cycle/TRACKERS.md, "Branches and commits"):\n'
                     '  %s\n\n  <message>\n\nA commit for another ticket on this branch starts the message with that '
                     'ticket\'s key:\n  %s\n\n  PROJ-124 <title> (BUG-...)\n' % (why, k, k))
    return 1


def cmd_worklog(argv):
    import worklog  # opt-in Jira worklogs (worklog.py, next to this file)
    return worklog.main(argv)


ESCAPE_HEADER = re.compile(r'^[+-]### \[((?:BUG|FEAT)-(\d+))\]')
ESCAPE_FIELD = re.compile(r'^[+-]- (?:\[[ x]\] )?\*\*(Found by|Class|Severity|Priority):\*\*\s*(.*)$')
ESCAPE_KEYS = ('Found by', 'Class', 'Severity', 'Priority')


def escape_window(root, o):
    """(label, start epoch) of the range `escapes` counts: --since REF, --days N, else the latest tag,
    else the last 90 days."""
    if o.get('days'):
        return 'last %s days' % o['days'], int(time.time()) - int(o['days']) * 86400
    ref = o.get('since') or git('describe', '--tags', '--abbrev=0', cwd=root)
    if ref:
        when = git('log', '-1', '--format=%ct', ref, cwd=root)
        if not when:
            sys.exit('escapes: unknown ref %s' % ref)
        return 'since %s' % ref, int(when)
    return 'last 90 days (no tag)', int(time.time()) - 90 * 86400


def filed_findings(root, start):
    """Entries whose epoch id was minted at or after START, as {id: {field: value}}. An entry still
    in a tracker is read from the file; one migrated or closed since is read from its newest full
    block in git history (the removal commit's `-` lines hold its final state)."""
    found = {}
    for p in tracker_files(root):
        for e in TrackerFile(p).entries:
            m = re.match(r'(?:BUG|FEAT)-(\d+)$', e.id)
            if m and int(m.group(1)) >= start and e.id not in found:
                found[e.id] = {k: e.value(k) for k in ESCAPE_KEYS if e.value(k)}
    since = time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(start - 86400))
    log = git('log', '--since=' + since, '--format=', '-p', '-U0', '--no-color', '--', '*bugs.md',
              '*features.md', cwd=root) or ''
    cur = None
    for line in log.splitlines():
        m = ESCAPE_HEADER.match(line)
        if m:
            cur = None
            if int(m.group(2)) >= start and m.group(1) not in found:
                cur = found.setdefault(m.group(1), {})
            continue
        if line[:1] not in '+-' or line.startswith(('+++', '---')):
            cur = None
            continue
        f = ESCAPE_FIELD.match(line)
        if f and cur is not None:
            cur.setdefault(f.group(1), f.group(2).strip())
    return found


def cmd_escapes(argv):
    """escapes [--since REF | --days N] [--json]: where the bugs (and features with `Found by`) filed in the window were found
    (`Found by`) and their class (`Class`), so a change to the delivery skills can be judged by its
    effect on findings (E33). Reads git history; writes nothing."""
    o, _ = opts(argv, flags=('json',))
    root = repo_root()
    label, start = escape_window(root, o)
    # A feature is planned work unless it says where it was found (a gap the protocol or an audit filed).
    found = {k: v for k, v in filed_findings(root, start).items() if k.startswith('BUG-') or v.get('Found by')}
    by, cls = {}, {}
    for fid, f in found.items():
        who = f.get('Found by') or 'unstated'
        sev = (f.get('Severity') or f.get('Priority') or '?').split()[0].lower()
        by.setdefault(who, {}).setdefault(sev, 0)
        by[who][sev] += 1
        c = f.get('Class') or 'unstated'
        cls[c] = cls.get(c, 0) + 1
    if o.get('json'):
        print(json.dumps({'window': label, 'start': start, 'findings': found, 'found_by': by, 'class': cls}, indent=1))
        return 0
    print('escapes %s: %d findings filed' % (label, len(found)))
    if not found:
        return 0
    print('| Found by | crit | high | med | low | total |\n|---|---|---|---|---|---|')
    for who in sorted(by, key=lambda w: (-sum(by[w].values()), w)):
        row = by[who]
        print('| %s | %s | %d |' % (who, ' | '.join(str(row.get(s, 0)) for s in LEVELS), sum(row.values())))
    print('\n| Class | total |\n|---|---|')
    for c in sorted(cls, key=lambda k: (-cls[k], k)):
        print('| %s | %d |' % (c, cls[c]))
    unstated = sum(by.get('unstated', {}).values())
    if unstated:
        print('\n%d without `Found by` (set it: `set <ID> "Found by" <%s>`)' % (unstated, '|'.join(FOUND_BY)))
    return 0


COMMANDS = {'branch': cmd_branch, 'add': cmd_add, 'set': cmd_set, 'log': cmd_log, 'migrate': cmd_migrate, 'close': cmd_close,
            'show': cmd_show, 'freeze': cmd_freeze, 'export': cmd_export, 'jira': cmd_jira, 'adopt': cmd_adopt, 'hook': cmd_hook,
            'bundle': cmd_bundle, 'commit-msg': cmd_commit_msg, 'worklog': cmd_worklog, 'plan': cmd_plan,
            'jira-guard': cmd_jira_guard, 'api-guard': cmd_jira_guard,
            'escapes': cmd_escapes}
