# Articles requirements — Linky

Related: [SRS index](../SRS.md). ADOPT baseline `1a69229`, 2026-11-26.

This area owns public articles, PDF documents, MyAnimeList catalogue entries and the Telegraph fallbacks. See docs/srs/social.md for Truth Social, LinkedIn posts and their uploaded-media panels; see docs/srs/replies.md for comments. See docs/srs/commands.md for settings/manual command surfaces and docs/srs/core.md for eligibility, source ownership, confirmation, mention policy and shared privacy/security constraints. The public-page transport below is the scoped fixed-host exception discussed in TBD-S0-001. No API key is required for this area; an explicit operator platform list must include articles, while its setting gates articles/PDF/MyAnimeList together. The article addition to FEAT-1790270880 is part of the cross-platform operator evidence workflow: see docs/srs/ops.md. The hot-path benchmark and command refactoring backlog likewise belong to core/ops/commands, without duplicate requirements here.

Delivery is conservatively Implemented from inspected code; this pass executes no application or live-provider tests and promotes no requirement to Verified. Named tests are verification targets. Acceptance marked `(derived, confirm)` needs product-owner confirmation; the parent index holds those TBDs.

## 3. Requirements

### 3.1 Functions

#### ART-FR-001 — Public article metadata
The system shall prepare a public article card only from a usable title and Open Graph article metadata or matching Article, NewsArticle or BlogPosting JSON-LD in the HTML head.

- Priority: Must
- Rationale: Restricts the authored card to identified editorial metadata
- Source: src/services/ArticlePreview.ts (parseMetadata, structuredArticle); docs/article-previews.md, Supported pages and controls
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/ArticlePreview.ts (parseMetadata, structuredArticle))
- UI: Discord — automatic or manual article card
- Acceptance:
  - Given a public head with article identity and a usable title, when parsed, then a card is prepared; given neither, when parsed, then no ordinary article card is prepared.
- Traces: API-043, CMP-006

#### ART-FR-002 — Compact attributed article card
The system shall display the linked headline with Publisher attribution, a metadata excerpt of at most 300 characters, and an eligible image and valid publication date when supplied.

- Priority: Must
- Rationale: Shows the publisher material and its provenance
- Source: src/services/ArticlePreview.ts (formatArticlePreview); README.md, public article previews
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/ArticlePreview.ts (formatArticlePreview))
- UI: Discord — article embed
- Acceptance:
  - Given metadata with headline, publisher, excerpt, image and valid date, when formatted, then the attributed card contains those fields with the excerpt limited to 300 characters.
- Traces: API-043, CMP-006, CMP-005

#### ART-FR-003 — MyAnimeList catalogue exception
The system shall accept MyAnimeList anime or manga entry metadata only when requested, final, canonical and og:url identities name the same entry and the declared type matches anime video.tv_show/video.movie or manga books.book.

- Priority: Must
- Rationale: Supports catalogue cards without admitting profiles and lists
- Source: src/services/ArticlePreview.ts (myAnimeListEntry, parseMetadata); docs/article-previews.md, Supported pages and controls
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/ArticlePreview.ts (myAnimeListEntry, parseMetadata))
- UI: Discord — MyAnimeList card
- Acceptance:
  - Given matching anime or manga entry identities, when the accepted type and usable title exist without player metadata, then a card is prepared.
  - Given a profile, list, entry subpage or identity mismatch, when parsed, then the catalogue exception does not apply.
- Traces: API-043, CMP-006

#### ART-FR-004 — Catalogue presentation
The system shall label a MyAnimeList card Source with Anime or Manga metadata and display the synopsis and cover when available.

- Priority: Must
- Rationale: Distinguishes catalogue metadata from journalism
- Source: src/services/ArticlePreview.ts (formatArticlePreview); README.md, public article previews
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/ArticlePreview.ts (formatArticlePreview))
- UI: Discord — MyAnimeList embed
- Acceptance:
  - Given a prepared manga or anime entry, when formatted, then its source and catalogue type are labelled and available synopsis and cover are included.
- Traces: API-043, CMP-006

#### ART-FR-005 — Preserve native media candidates
The system shall decline the ordinary article path for declared video/music or Twitter player pages and known native-media hosts except the narrowly validated MyAnimeList type exception.

- Priority: Must
- Rationale: Avoids replacing native players with article text
- Source: src/services/ArticlePreview.ts (EXCLUDED, parseMetadata); docs/article-previews.md, Supported pages and controls
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/ArticlePreview.ts (EXCLUDED, parseMetadata))
- UI: Discord — existing source preview
- Acceptance:
  - Given a native-media host or declared player even with Article JSON-LD, when evaluated, then no ordinary article card is prepared.
- Traces: API-043, CMP-006

#### ART-FR-006 — Bounded complete article set
The system shall prepare at most three distinct article-family links as one complete set before publishing an authored article message.

- Priority: Must
- Rationale: A partial set could hide another link preview
- Source: src/services/ArticlePosts.ts (prepareArticlePosts, articleEmbeds); docs/article-previews.md, Supported pages and controls
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/ArticlePosts.ts (prepareArticlePosts, articleEmbeds))
- UI: Discord — multi-card message
- Acceptance:
  - Given one to three prepared distinct links, when all cards succeed, then the complete set can be delivered.
  - Given more than three sources or any failed/mismatched source, when prepared, then the set is rejected.
  - Given canonical aliases, when their card metadata agrees, then they share one card; when it disagrees, then the set is rejected.
- Traces: API-043, API-035, CMP-005

#### ART-FR-007 — Mixed-link guidance
The system shall retain the source of a mixed article and other-link message with split-message guidance when that response is supported.

- Priority: Must
- Rationale: Authored embeds can suppress other native unfurls
- Source: src/services/ArticlePosts.ts (hasMixedArticleLinks, ARTICLE_MIXED_GUIDANCE); src/services/SocialLinkService.ts; docs/article-previews.md, Supported pages and controls
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/ArticlePosts.ts (hasMixedArticleLinks, ARTICLE_MIXED_GUIDANCE))
- UI: Discord — split-message guidance
- Acceptance:
  - Given a visible article candidate mixed with another platform link, when mixed-link guidance is available, then it asks the sharer to share articles separately and states the original is unchanged.
- Traces: API-035, CMP-005, CMP-068

#### ART-FR-008 — Unusable candidate preserves the message
The system shall leave an automatic source message unchanged when any article candidate has no usable metadata or supported PDF/Telegraph fallback.

- Priority: Must
- Rationale: Prevents losing adjacent supported links
- Source: src/services/ArticlePosts.ts (prepareArticlePosts); src/services/SocialLinkService.ts; README.md, public article previews
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/ArticlePosts.ts (prepareArticlePosts))
- UI: Discord — original message
- Acceptance:
  - Given an unsupported website beside a supported social link, when the article candidate cannot be prepared, then automatic processing preserves the complete original message.
- Traces: API-035, API-043, CMP-005, CMP-068

#### ART-FR-009 — Telegraph refusal admission
The system shall use the Telegraph fallback only for exact Telegraph hosts with matching requested/final dated editorial paths and HTTP 402 containing the specific valid TollBit Token refusal.

- Priority: Must
- Rationale: Does not mistake a refusal for readable article metadata
- Source: src/services/ArticlePreview.ts (telegraphLinkPreview, request); docs/article-previews.md, Supported pages and controls
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/ArticlePreview.ts (telegraphLinkPreview, request))
- UI: Discord — Telegraph card
- Acceptance:
  - Given a valid dated matching Telegraph path and the specific refusal, when public metadata is unavailable, then the fallback is eligible.
  - Given an invalid date, foreign host, different final path or another error, when evaluated, then no fallback card is prepared.
- Traces: API-043, API-044, CMP-006

#### ART-FR-010 — Bing News provenance
The system shall display the exact matching Telegraph Bing News RSS headline, excerpt and approved thumbnail as Publisher: The Telegraph with Headline via Bing News and no publication timestamp.

- Priority: Must
- Rationale: Bing indexing time is not publication time
- Source: src/services/ArticlePreview.ts (parseBingNewsFeed, formatArticlePreview); docs/article-previews.md, Supported pages and controls
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/ArticlePreview.ts (parseBingNewsFeed, formatArticlePreview))
- UI: Discord — Telegraph Bing News card
- Acceptance:
  - Given an RSS item with the exact supported article path, when selected, then its headline is credited to Bing News without its indexing timestamp.
  - Given an unrelated URL or foreign thumbnail host, when parsed, then that item or thumbnail is not used.
- Traces: API-044, CMP-006

#### ART-FR-011 — URL-title abstention
The system shall show a readable Telegraph slug title labelled Title from URL and Site: The Telegraph with no excerpt, image or publication time when the eligible Bing lookup has no timely usable match.

- Priority: Must
- Rationale: Keeps inferred text distinct from publisher claims
- Source: src/services/ArticlePreview.ts (telegraphLinkPreview, request, formatArticlePreview); docs/article-previews.md, Supported pages and controls
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/ArticlePreview.ts (telegraphLinkPreview, request, formatArticlePreview))
- UI: Discord — Telegraph URL-title card
- Acceptance:
  - Given a qualifying refusal and absent, failed or slow Bing result, when fallback is formatted within the article deadline, then only the labelled URL title is shown.
  - Given usable public metadata, when the page succeeds, then normal metadata takes precedence.
- Traces: API-043, API-044, CMP-006

#### ART-FR-012 — PDF recognition
The system shall prepare PDF cards only for a successful accepted PDF MIME response or an accepted octet-stream response on a .pdf path whose prefix contains a PDF header.

- Priority: Must
- Rationale: Avoids treating arbitrary binary data as a document
- Source: src/services/ArticlePreview.ts (request); src/services/PdfPreview.ts (isPdf); docs/article-previews.md, Supported pages and controls
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/ArticlePreview.ts (request))
- UI: Discord — PDF card
- Acceptance:
  - Given application/pdf or application/x-pdf with a PDF header in the first 1024 bytes, when read, then a PDF card can be prepared.
  - Given application/octet-stream or binary/octet-stream, when the path ends in .pdf and the header is present, then it can be prepared; otherwise it is rejected.
- Traces: API-043, CMP-006, CMP-044

#### ART-FR-013 — PDF title provenance
The system shall choose a usable PDF information-dictionary title or XMP title before a usable largest upright first-page heading and finally the file name with the corresponding title-source footer.

- Priority: Must
- Rationale: Makes title extraction provenance visible
- Source: src/services/PdfPreview.ts (parsePdf, headingTitle, usableTitle); src/services/ArticlePreview.ts (formatArticlePreview); docs/article-previews.md, Supported pages and controls
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/PdfPreview.ts (parsePdf, headingTitle, usableTitle))
- UI: Discord — PDF title/footer
- Acceptance:
  - Given a usable declared title, when parsed, then metadata takes precedence and the footer says Title from document metadata.
  - Given no usable declared title and a qualifying first-page heading, when parsed, then the footer says Title from first page; otherwise it says Title from file name.
  - Given first-page extraction, when headingTitle evaluates runs, then its baseline is the text-length-dominant font size, its largest size must be at least 1.15 times that baseline, and runs within 0.25 size units of the largest are joined; unreadable or inadequate evidence abstains to the file name.
- Traces: API-043, CMP-044, CMP-006

#### ART-FR-014 — PDF declared facts
The system shall display a PDF document card labelled with its host and available declared author, page count, full declared file size and creation time.

- Priority: Must
- Rationale: Reports document facts without content analysis
- Source: src/services/PdfPreview.ts (parsePdf, formatPdfSize); src/services/ArticlePreview.ts (formatArticlePreview); README.md, PDF cards
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/PdfPreview.ts (parsePdf, formatPdfSize))
- UI: Discord — PDF facts
- Acceptance:
  - Given parsed facts, when formatted, then available document facts accompany PDF document: host.
  - Given a page count, when shown, then it is a positive integer at most 100000 from parsed page-tree structure; absent or invalid counts are omitted.
  - Given a known full size, when displayed, then values below 1024 use bytes, below 1048576 use rounded binary KB, and larger sizes use one decimal binary MB; missing sizes are omitted, with no comparative baseline or statistical sample claimed.
- Traces: API-043, CMP-044, CMP-006

#### ART-FR-015 — Encrypted or incomplete PDFs
The system shall retain only safely available structural PDF facts with a labelled file-name fallback when encryption or incomplete structure prevents title extraction.

- Priority: Must
- Rationale: Avoids interpreting ciphertext or missing pages
- Source: src/services/PdfPreview.ts (parsePdf); docs/article-previews.md, Supported pages and controls
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/PdfPreview.ts (parsePdf))
- UI: Discord — PDF fallback card
- Acceptance:
  - Given an encrypted PDF, when parsed, then the title stays the file name and decrypted title, author and creation time are not invented.
  - Given a truncated prefix whose first page is unavailable, when parsing fails, then the labelled file name remains with safely available size or structure.
- Traces: API-043, CMP-044

### 3.2 Performance requirements

#### ART-NFR-001 — Retrieval capacity
The system shall bound article-family retrieval admission and retention to the implemented process-wide limits.

- Priority: Must
- Rationale: Bounds shared provider cost
- Source: src/services/ArticlePreview.ts (createArticleLookup); docs/article-previews.md, Request limits and privacy
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/ArticlePreview.ts (createArticleLookup))
- Measure: Per process: 4 active ordinary lookups, 30 new/minute; 100 memory entries; successes 300000 ms, misses and URL-title cards 15000 ms; shared family cached-file-byte cap 32 MiB. Same-source work coalesces; no unbounded admission queue.
- Acceptance:
  - Given four pending lookups or thirty new lookups in the current minute, when another uncached lookup arrives, then it is refused.
  - Given cached success or failure, when its reuse window expires, then it is not reused.
- Traces: API-043, API-044, CMP-006

#### ART-NFR-002 — Bounded PDF parsing
The system shall limit PDF structural and first-page parsing to its fixed parser budgets.

- Priority: Must
- Rationale: Malformed PDFs must terminate within explicit work bounds
- Source: src/services/PdfPreview.ts (parser constants); docs/article-previews.md, Request limits and privacy
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/PdfPreview.ts (parser constants))
- Measure: 4 MiB fetched prefix; 4 MiB inflated/stream, 24 MiB total; 50000 objects; 256 object streams; depth 24; 4000000 tokens; 2 MiB first-page content; 60000 operators; 65536 CMap codes. Verification targets tests/pdf-preview.test.ts and tests/article-preview.test.ts.
- Acceptance:
  - Given hostile inflation, nesting, object or operator counts, when a budget is exhausted, then parsing stops or falls back without expanding that budget.
- Traces: API-043, CMP-044

### 3.3 Usability requirements

No separate area requirement: shared Discord interaction and accessibility behavior is owned by [core](core.md).

### 3.4 Interface requirements

#### ART-IR-001 — Public-page transport exception
The system shall retrieve article/PDF candidates through the validated public-page API-043 transport.

- Priority: Must
- Rationale: General articles need public publisher hosts beyond a fixed allowlist
- Source: src/services/ArticlePreview.ts (publicUrl, publicAddresses, request); docs/article-previews.md, Request limits and privacy
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/ArticlePreview.ts (publicUrl, publicAddresses, request))
- Acceptance:
  - Given a candidate, when fetched, then each hop validates public IPv4 DNS and pins the selected address with TLS verification; literal IPs, local names, explicit ports, URL credentials and excluded service/provider paths are rejected.
  - Given a compressed response or unsupported response/error, when read, then it is rejected; HTML stops at the head or 512 KiB and PDFs at a 4 MiB prefix within five seconds and at most three validated redirects.
- Traces: API-043, CMP-006

#### ART-IR-002 — Scoped Telegraph index request
The system shall request one fixed-host Bing News RSS lookup using Telegraph slug words under the article deadline.

- Priority: Must
- Rationale: Provides attributed headline evidence without fetching article body text
- Source: src/services/ArticlePreview.ts (bingNewsPath, request); docs/article-previews.md, Request limits and privacy
- Verification: Test
- Status: Approved
- Delivery: Implemented (code: src/services/ArticlePreview.ts (bingNewsPath, request))
- Acceptance:
  - Given the eligible refusal, when querying Bing, then slug words plus the site restriction are sent to www.bing.com with public-DNS pinning, no redirects, a 512 KiB cap and a 250 ms margin before the five-second deadline; refusal reading is limited to 4 KiB.
- Traces: API-044, CMP-006

### 3.5 Logical database requirements

No separate area requirement: shared Discord interaction and accessibility behavior is owned by [core](core.md).

### 3.6 Design constraints

#### ART-CON-001 — Metadata-only purpose
The system shall use only the supported metadata, labelled index/URL fallbacks and bounded first-page PDF text rather than generate summaries, fact-check, translate, execute page scripts or bypass login/paywall restrictions.

- Priority: Must
- Rationale: Defines the feature scope
- Source: src/services/ArticlePreview.ts; src/services/PdfPreview.ts; README.md, public article previews; docs/article-previews.md, introduction
- Verification: Analysis
- Status: Approved
- Delivery: Implemented (code: src/services/ArticlePreview.ts)
- Acceptance:
  - Given a blocked or private page outside a supported labelled fallback, when requested, then no login, article-body extraction or generated summary is attempted.
- Traces: API-043, API-044, CMP-006, CMP-044

### 3.7 Software system attributes

#### 3.7.1 Reliability

See docs/srs/core.md for product-wide attributes; scoped behavior is specified above. 

#### 3.7.2 Availability

See docs/srs/core.md for product-wide attributes; scoped behavior is specified above. No production availability or latency percentile is inferred from selected historical trials.

#### 3.7.3 Security

See docs/srs/core.md for product-wide attributes; scoped behavior is specified above. 

#### 3.7.4 Maintainability

See docs/srs/core.md for product-wide attributes; scoped behavior is specified above. 

#### 3.7.5 Portability

See docs/srs/core.md for product-wide attributes; scoped behavior is specified above. 

#### 3.7.6 Privacy and compliance

See docs/srs/core.md for product-wide attributes; scoped behavior is specified above. 

#### 3.7.7 Observability

See docs/srs/core.md for product-wide attributes; scoped behavior is specified above. 

### 3.8 Supporting information

The Telegraph fallback is a labelled news-index or URL-derived card, not evidence that the article was read. PDF page counts and declared dates describe the document, not an assessment of its content.

## 5. Appendices

### 5.1 Traceability matrix

| Req | Priority | Delivery | Entities | APIs / Events | Components | Verification |
|---|---|---|---|---|---|---|
| `ART-FR-001` | Must | Implemented | — | API-043 | CMP-006 | Test |
| `ART-FR-002` | Must | Implemented | — | API-043 | CMP-006, CMP-005 | Test |
| `ART-FR-003` | Must | Implemented | — | API-043 | CMP-006 | Test |
| `ART-FR-004` | Must | Implemented | — | API-043 | CMP-006 | Test |
| `ART-FR-005` | Must | Implemented | — | API-043 | CMP-006 | Test |
| `ART-FR-006` | Must | Implemented | — | API-043, API-035 | CMP-005 | Test |
| `ART-FR-007` | Must | Implemented | — | API-035 | CMP-005, CMP-068 | Test |
| `ART-FR-008` | Must | Implemented | — | API-035, API-043 | CMP-005, CMP-068 | Test |
| `ART-FR-009` | Must | Implemented | — | API-043, API-044 | CMP-006 | Test |
| `ART-FR-010` | Must | Implemented | — | API-044 | CMP-006 | Test |
| `ART-FR-011` | Must | Implemented | — | API-043, API-044 | CMP-006 | Test |
| `ART-FR-012` | Must | Implemented | — | API-043 | CMP-006, CMP-044 | Test |
| `ART-FR-013` | Must | Implemented | — | API-043 | CMP-044, CMP-006 | Test |
| `ART-FR-014` | Must | Implemented | — | API-043 | CMP-044, CMP-006 | Test |
| `ART-FR-015` | Must | Implemented | — | API-043 | CMP-044 | Test |
| `ART-NFR-001` | Must | Implemented | — | API-043, API-044 | CMP-006 | Test |
| `ART-NFR-002` | Must | Implemented | — | API-043 | CMP-044 | Test |
| `ART-IR-001` | Must | Implemented | — | API-043 | CMP-006 | Test |
| `ART-IR-002` | Must | Implemented | — | API-044 | CMP-006 | Test |
| `ART-CON-001` | Must | Implemented | — | API-043, API-044 | CMP-006, CMP-044 | Analysis |

## Revision history

| Rev | Date | Commit | Mode | Summary |
|---|---|---|---|---|
| 1 | 2026-11-26T15:36:20-05:00 | 59a2e7d6f4ec | ADOPT | ART-FR-001 through ART-FR-015; ART-NFR-001 through ART-NFR-002; ART-IR-001 through ART-IR-002; ART-CON-001 |
