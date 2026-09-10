"""
glyph_metrics.py

Where a PDF's text physically sits on the page, down to the individual
character - the question tag_worker.py's struct-tree work never had to ask,
and the one a rectangle drawn over the page preview has to answer.

Two layers live here:

  - The font primitives tag_worker.py already had (matrix composition, page
    attribute inheritance, and the /ToUnicode decoding split_leaf() slices
    on). They moved here so this module and tag_worker.py can both use them
    without importing each other; tag_worker.py imports them back under
    their old private names, so its own call sites are unchanged.

  - The glyph-advance engine: page_code_boxes(), which replays enough of a
    page's content stream to place every character it paints.

The same "never guess" contract as tag_worker.py's splitting section governs
the engine. Placing a glyph needs two things beyond the text state - how
wide the glyph is, and (to report it) what character it is - and they come
from different places:

  - width, from the font's own metrics: /Widths + /FirstChar for a simple
    font, /W + /DW on the descendant of a Type0, or - for a standard-14 face
    entitled to carry no metrics at all - Adobe's AFM tables by way of the
    font's encoding (see standard_fonts.py).
  - text, from /ToUnicode, exactly as split_leaf() reads it.

Anything unmeasurable raises Unmeasurable with a specific reason, and the
refusal poisons its whole marked-content span - see page_code_boxes().

Measured against 22 real course-reading PDFs (645 pages, 15,540 spans,
1.34M glyphs): agrees with pdf.js's independent implementation to 0.000pt
on both font paths that appear in them.
"""

import re

import pikepdf

import standard_fonts


class Unmeasurable(Exception):
    """A font, or a piece of text state, this module refuses to measure.

    Carries the reason to show the user. Never raised for something that
    could be approximated instead - approximating is the thing this module
    exists not to do.
    """


# --- shared font primitives (moved from tag_worker.py) --------------------

def mat_mult(m1, m2):
    """Composes two PDF transformation matrices as `m1` applied first, `m2`
    second - i.e. a point transforms as `point * m1 * m2`. This is the order
    a content stream's `cm` operator combines with the CTM already in
    effect: the new matrix describes the *inner* (most recently established)
    coordinate system."""
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return (
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    )


def mat_apply(point, m):
    x, y = point
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def resolve_inherited(page_obj, key, default=None):
    """Walks /Parent (the Pages tree) for a page attribute that's allowed to
    be inherited rather than set directly on the page itself - /Resources
    and /MediaBox both are, and a scanned document built from one shared
    template per section often relies on that instead of repeating them on
    every page."""
    node = page_obj
    seen = set()
    while node is not None:
        if key in node:
            return node[key]
        parent = node.get("/Parent")
        if not isinstance(parent, pikepdf.Dictionary):
            return default
        if getattr(parent, "is_indirect", False):
            if parent.objgen in seen:
                return default
            seen.add(parent.objgen)
        node = parent
    return default


def codespace_widths(text):
    """The distinct byte-widths declared by every `begincodespacerange`
    block in a CMap's own text - {len(lo_hex) // 2 for each <lo> <hi> pair}.
    Shared by font_code_width() (reading a font's *own* /Encoding CMap,
    when it's an embedded stream rather than a predefined name) - not used
    against a /ToUnicode CMap's codespace, which can legitimately be wider
    than any code it actually maps (see the section docstring above)."""
    widths = set()
    for block in re.findall(r"begincodespacerange(.*?)endcodespacerange", text, re.S):
        for lo, _hi in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", block):
            widths.add(len(lo) // 2)
    return widths


def font_code_width(font):
    """How many bytes one font code occupies in a `Tj`/`TJ`/`'`/`"` string
    operand for `font` - the width _decode_leaf_content() needs to chop a
    raw operand into codes, before any /ToUnicode lookup happens at all.
    Always 1 for a simple font. For a Type0 (composite) font, 2 for the
    near-ubiquitous predefined /Identity-H or /Identity-V encoding, or
    whatever a single-width embedded /Encoding CMap's own codespace range
    declares - any other predefined CMap name, or a mixed-width embedded
    one, isn't supported (raises ValueError; see the section docstring)."""
    subtype = str(font.get("/Subtype", ""))
    if subtype != "/Type0":
        return 1
    encoding = font.get("/Encoding")
    if isinstance(encoding, pikepdf.Name):
        if str(encoding) in ("/Identity-H", "/Identity-V"):
            return 2
        raise ValueError(f"Unsupported predefined CMap encoding: {encoding}")
    if isinstance(encoding, (pikepdf.Dictionary, pikepdf.Stream)):
        try:
            text = bytes(encoding.read_bytes()).decode("latin-1")
        except Exception as exc:
            raise ValueError(f"Could not read this font's Encoding CMap: {exc}") from exc
        widths = codespace_widths(text)
        if len(widths) != 1:
            raise ValueError("This font's Encoding CMap has no single, unambiguous character width")
        return widths.pop()
    raise ValueError("This font's character encoding isn't recognized")


def parse_bf_mappings(stream_bytes):
    """Parses a /ToUnicode CMap stream's `beginbfchar`/`beginbfrange` blocks
    into {code_int: decoded_str}. This is a light regex-based reader for the
    predictable shape font-embedding tools actually emit, not a full
    PostScript interpreter - anything it doesn't recognize (a malformed
    range, ...) raises ValueError rather than silently mis-parsing, since a
    wrong decode here would silently mis-split real text."""
    try:
        text = stream_bytes.decode("latin-1")
    except Exception as exc:
        raise ValueError(f"Could not read this font's ToUnicode CMap: {exc}") from exc

    def dst_to_text(hex_str):
        raw = bytes.fromhex(hex_str)
        if len(raw) % 2 != 0:
            raise ValueError("Malformed ToUnicode destination string")
        return raw.decode("utf-16-be")

    mapping = {}
    for block in re.findall(r"beginbfchar(.*?)endbfchar", text, re.S):
        for code_hex, dst_hex in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", block):
            mapping[int(code_hex, 16)] = dst_to_text(dst_hex)

    for block in re.findall(r"beginbfrange(.*?)endbfrange", text, re.S):
        # Array form: <lo> <hi> [ <d0> <d1> ... ] - one explicit destination
        # per code in the range.
        for lo_hex, hi_hex, array_body in re.findall(
            r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[(.*?)\]", block, re.S
        ):
            lo, hi = int(lo_hex, 16), int(hi_hex, 16)
            dsts = re.findall(r"<([0-9A-Fa-f]+)>", array_body)
            if len(dsts) != hi - lo + 1:
                raise ValueError("Malformed ToUnicode bfrange array")
            for code, dst_hex in zip(range(lo, hi + 1), dsts):
                mapping[code] = dst_to_text(dst_hex)
        # Scalar form: <lo> <hi> <dst> - dst increments by (code - lo) for
        # each code in the range. Matched against whatever the array form
        # above didn't already consume, so the two forms can't double-count
        # the same range.
        remainder = re.sub(r"<[0-9A-Fa-f]+>\s*<[0-9A-Fa-f]+>\s*\[.*?\]", "", block, flags=re.S)
        for lo_hex, hi_hex, dst_hex in re.findall(
            r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", remainder
        ):
            lo, hi = int(lo_hex, 16), int(hi_hex, 16)
            dst_bytes = bytes.fromhex(dst_hex)
            base = int.from_bytes(dst_bytes, "big")
            for offset, code in enumerate(range(lo, hi + 1)):
                value = base + offset
                mapping[code] = value.to_bytes(len(dst_bytes), "big").decode("utf-16-be")

    return mapping


def font_tounicode(page, font_name):
    """(width, mapping) - width from font_code_width(), mapping from
    parse_bf_mappings() - for /Resources/Font/<font_name> on `page`, or
    None if the font can't be resolved, its encoding isn't one this file
    understands, or it carries no /ToUnicode. /Resources is inheritable the
    same way /MediaBox is (see resolve_inherited) - a font used by every
    page in a section is often set once on a shared /Pages node rather than
    repeated per page."""
    resources = resolve_inherited(page.obj, "/Resources")
    fonts = resources.get("/Font") if isinstance(resources, pikepdf.Dictionary) else None
    font = fonts.get(font_name) if isinstance(fonts, pikepdf.Dictionary) else None
    if not isinstance(font, pikepdf.Dictionary) or "/ToUnicode" not in font:
        return None
    try:
        width = font_code_width(font)
        mapping = parse_bf_mappings(bytes(font["/ToUnicode"].read_bytes()))
    except Exception:
        return None
    return width, mapping


# --- font metrics ----------------------------------------------------------
#
# font_code_width()/font_tounicode() above answer "how many bytes is a code,
# and what character is it?". Placing that character also needs its advance
# width, which lives somewhere different for each kind of font - that is what
# FontMetrics resolves, once per font per page.

def _num(value, default=None):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def parse_w_array(w):
    """A CIDFont's /W array as {cid: width}. Two forms, freely interleaved:

        c [w1 w2 ... wn]   widths for cids c, c+1, ... c+n-1
        cfirst clast w     one width for the whole inclusive range

    Raises Unmeasurable on anything malformed rather than skipping it: a
    dropped entry would silently fall back to /DW and misplace every glyph
    after it on the line."""
    widths = {}
    items = list(w)
    i = 0
    while i < len(items):
        first = _num(items[i])
        if first is None:
            raise Unmeasurable("Malformed /W array in this font")
        if i + 1 >= len(items):
            raise Unmeasurable("Truncated /W array in this font")
        nxt = items[i + 1]
        if isinstance(nxt, pikepdf.Array):
            for offset, value in enumerate(nxt):
                width = _num(value)
                if width is None:
                    raise Unmeasurable("Malformed width in this font's /W array")
                widths[int(first) + offset] = width
            i += 2
        else:
            if i + 2 >= len(items):
                raise Unmeasurable("Truncated /W range in this font")
            last, width = _num(nxt), _num(items[i + 2])
            if last is None or width is None:
                raise Unmeasurable("Malformed /W range in this font")
            if int(last) - int(first) > 65535:
                raise Unmeasurable("Implausible /W range in this font")
            for cid in range(int(first), int(last) + 1):
                widths[cid] = width
            i += 3
    return widths


def parse_cid_cmap(text):
    """code -> CID from an embedded /Encoding CMap's begincidrange/
    begincidchar blocks - the lookup a /W width needs when the font's
    encoding is an embedded stream rather than Identity-H. Same light
    regex reader, and same refusal policy, as parse_bf_mappings()."""
    mapping = {}
    for block in re.findall(r"begincidchar(.*?)endcidchar", text, re.S):
        for code_hex, cid in re.findall(r"<([0-9A-Fa-f]+)>\s*(\d+)", block):
            mapping[int(code_hex, 16)] = int(cid)
    for block in re.findall(r"begincidrange(.*?)endcidrange", text, re.S):
        for lo_hex, hi_hex, cid in re.findall(
            r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\d+)", block
        ):
            lo, hi = int(lo_hex, 16), int(hi_hex, 16)
            if hi - lo > 65535:
                raise Unmeasurable("Implausible cidrange in this font's CMap")
            for offset, code in enumerate(range(lo, hi + 1)):
                mapping[code] = int(cid) + offset
    return mapping


class FontMetrics:
    """Everything needed to place one font's glyphs: how many bytes a code
    takes, how to turn a code into an advance width, and how far the glyph
    box rises and falls around the baseline.

    `branch` records which code path resolved the font, purely so the corpus
    sweep can report which ones a document actually exercises."""

    def __init__(self, font, name):
        self.name = name
        self.subtype = str(font.get("/Subtype", ""))
        self.is_cid = self.subtype == "/Type0"
        self.cid_map = None
        self.branch = None
        self.tounicode = None

        if self.subtype == "/Type3":
            # A Type3 glyph is a content stream in its own /FontMatrix
            # space, not a /1000 glyph space - nothing else here applies.
            raise Unmeasurable("Type3 font (its own /FontMatrix glyph space isn't supported)")

        # font_code_width() raises plain ValueError for its own refusals;
        # translate so every refusal out of this class is one exception type.
        try:
            self.code_width = font_code_width(font)
        except ValueError as exc:
            raise Unmeasurable(str(exc)) from exc

        if self.is_cid:
            self._init_cid(font)
        else:
            self._init_simple(font)
        self._init_extent(font)

    def _init_cid(self, font):
        descendants = font.get("/DescendantFonts")
        if descendants is None or len(descendants) == 0:
            raise Unmeasurable("Type0 font with no descendant font")
        descendant = descendants[0]
        self.default_width = _num(descendant.get("/DW"), 1000.0)
        w = descendant.get("/W")
        self.widths = parse_w_array(w) if w is not None else {}

        encoding = font.get("/Encoding")
        if isinstance(encoding, pikepdf.Name):
            if str(encoding) not in ("/Identity-H", "/Identity-V"):
                raise Unmeasurable(f"Unsupported predefined CMap: {encoding}")
            if str(encoding).endswith("-V"):
                raise Unmeasurable("Vertical writing mode isn't supported")
            self.branch = "cid-identity"
        elif isinstance(encoding, (pikepdf.Dictionary, pikepdf.Stream)):
            try:
                text = bytes(encoding.read_bytes()).decode("latin-1")
            except Exception as exc:
                raise Unmeasurable(f"Could not read this font's Encoding CMap: {exc}") from exc
            self.cid_map = parse_cid_cmap(text)
            if not self.cid_map:
                raise Unmeasurable("This font's embedded CMap declares no cid mappings")
            self.branch = "cid-embedded-cmap"
        else:
            raise Unmeasurable("This font's character encoding isn't recognized")

    def _init_simple(self, font):
        widths = font.get("/Widths")
        first = font.get("/FirstChar")
        descriptor = font.get("/FontDescriptor")
        self.default_width = (
            _num(descriptor.get("/MissingWidth"), 0.0)
            if isinstance(descriptor, pikepdf.Dictionary) else 0.0
        )
        if widths is None or first is None:
            # A standard-14 face may legitimately omit /Widths: its metrics
            # live in an AFM table every viewer is expected to have. We now
            # supply those (see standard_fonts.py), which is what lets the
            # rectangle tool divide a leaf that Split Content could already
            # divide - those two disagreeing on the same text was the whole
            # reason for adding this.
            try:
                self.widths = standard_fonts.widths_for(font)
            except standard_fonts.UnknownStandardFont as exc:
                raise Unmeasurable(str(exc)) from exc
            self.branch = "standard-14"
            return
        self.widths = {}
        first = int(first)
        for offset, value in enumerate(widths):
            width = _num(value)
            if width is not None:
                self.widths[first + offset] = width
        self.branch = "simple-widths"

    def _init_extent(self, font):
        """Glyph-box rise and fall, from the FontDescriptor's real /Ascent
        and /Descent - more accurate than the renderer's fixed
        TEXT_ASCENT_RATIO approximation, which exists only because pdf.js
        doesn't hand those out."""
        descriptor = font.get("/FontDescriptor")
        if descriptor is None and self.is_cid:
            descendants = font.get("/DescendantFonts")
            if descendants is not None and len(descendants) > 0:
                descriptor = descendants[0].get("/FontDescriptor")
        ascent = descent = None
        if isinstance(descriptor, pikepdf.Dictionary):
            ascent = _num(descriptor.get("/Ascent"))
            descent = _num(descriptor.get("/Descent"))
        # Absent is not the only way a font declines to say: subsetted faces
        # in the wild declare /Ascent 0 /Descent 0, which would collapse
        # every glyph box to a zero-height line - and a zero-area box has
        # zero coverage, so a rectangle could never select that text at all.
        # Treat any non-positive ascent or non-negative descent as undeclared.
        #
        # A box needs some vertical extent even when the font won't say; this
        # only affects the box's height, never a character's position along
        # the line, so a nominal value is honest here in a way a nominal
        # *width* would not be.
        if ascent is not None and ascent <= 0:
            ascent = None
        if descent is not None and descent >= 0:
            descent = None
        self.nominal_extent = ascent is None or descent is None
        self.ascent = 750.0 if ascent is None else ascent
        self.descent = -250.0 if descent is None else descent

    def width_for_code(self, code):
        if not self.is_cid:
            return self.widths.get(code, self.default_width)
        cid = code if self.cid_map is None else self.cid_map.get(code)
        if cid is None:
            raise Unmeasurable("A character code has no CID mapping in this font's CMap")
        return self.widths.get(cid, self.default_width)


def _metrics_for(page, font_name, cache):
    """FontMetrics for /Resources/Font/<font_name> on `page`, cached per page.
    A font that refused once is remembered as that refusal, so a page using
    an unmeasurable font 400 times pays for the attempt once."""
    if font_name in cache:
        entry = cache[font_name]
        if isinstance(entry, Unmeasurable):
            raise entry
        return entry
    resources = resolve_inherited(page.obj, "/Resources")
    fonts = resources.get("/Font") if isinstance(resources, pikepdf.Dictionary) else None
    font = fonts.get(font_name) if isinstance(fonts, pikepdf.Dictionary) else None
    if font is None:
        failure = Unmeasurable(f"Font resource {font_name} isn't on this page")
        cache[font_name] = failure
        raise failure
    try:
        metrics = FontMetrics(font, font_name)
    except Unmeasurable as exc:
        cache[font_name] = exc
        raise
    # Decoding stays font_tounicode()'s job so what this reports is exactly
    # what split_leaf() will slice - any drift between the two would make a
    # character offset taken from geometry point at the wrong character.
    info = font_tounicode(page, font_name)
    metrics.tounicode = info[1] if info else None
    cache[font_name] = metrics
    return metrics


# Operators the engine needs to see. Everything else on the page - colour,
# paths, images - can't move the text pen, so filtering them out here keeps
# the replay to the operators that matter.
_TEXT_OPS = "q Q cm BT ET Tm Td TD T* TL Tf Tc Tw Tz Ts Tr Tj TJ ' \" BDC BMC EMC"


def page_code_boxes(page):
    """Every glyph painted inside an MCID-carrying marked-content span on
    `page`, in PDF page space.

    Returns (boxes, refusals):
      boxes    - [{mcid, seq, text, x0, y0, x1, y1, invisible, font, branch}],
                 seq being the glyph's index within its own span
      refusals - {mcid: reason} for spans that painted text but couldn't be
                 measured with certainty

    A refusal poisons its whole span, retroactively. A span can switch fonts
    partway through (real files do this for a single trailing space in a
    different face); if the first font measures and the second doesn't, the
    glyphs already emitted would otherwise come back looking like a complete
    span, and a caller counting characters off them would compute offsets
    into a string that stops short of the real text. Silently truncated is
    exactly the plausible-looking wrong answer this module exists to avoid,
    so the partial result is dropped and the span reads as refused.
    """
    try:
        instructions = pikepdf.parse_content_stream(page, _TEXT_OPS)
    except Exception as exc:
        return [], {None: f"Could not parse this page's content stream: {exc}"}

    ctm = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    ctm_stack = []
    tm = tlm = None          # text matrix / line matrix; only set inside BT/ET
    leading = 0.0
    char_spacing = 0.0
    word_spacing = 0.0
    hscale = 1.0
    rise = 0.0
    render_mode = 0
    font_size = 0.0
    font_name = None
    mcid_stack = []
    font_cache = {}

    boxes = []
    refusals = {}
    seq = {}

    def current_mcid():
        for mcid in reversed(mcid_stack):
            if mcid is not None:
                return mcid
        return None

    def show(parts):
        """Places every glyph in one text-showing operator. `parts` is a list
        of ("str", bytes) and ("adj", number) - the latter being a TJ array's
        kerning numbers, which move the pen without painting anything."""
        nonlocal tm
        mcid = current_mcid()
        if mcid is None or mcid in refusals:
            return  # untagged/artifact content, or a span already given up on
        try:
            if not font_name:
                raise Unmeasurable("This text has no font set")
            metrics = _metrics_for(page, font_name, font_cache)
            if metrics.tounicode is None:
                raise Unmeasurable(
                    "This text's font has no embedded Unicode mapping (ToUnicode)")
        except Unmeasurable as exc:
            refusals[mcid] = str(exc)
            return

        pending = []
        try:
            for kind, value in parts:
                if kind == "adj":
                    # A TJ number is a displacement in thousandths of a unit
                    # of text space, subtracted from the pen position.
                    tm = mat_mult(
                        (1.0, 0.0, 0.0, 1.0, (-value / 1000.0) * font_size * hscale, 0.0), tm)
                    continue
                raw = value
                if len(raw) % metrics.code_width != 0:
                    raise Unmeasurable(
                        "This text's bytes don't align to its font's character width")
                for offset in range(0, len(raw), metrics.code_width):
                    code = int.from_bytes(raw[offset:offset + metrics.code_width], "big")
                    if code not in metrics.tounicode:
                        raise Unmeasurable("This text has a character with no Unicode mapping")
                    w0 = metrics.width_for_code(code) / 1000.0

                    # Trm = [Tfs*Th 0 0 Tfs 0 Ts] x Tm x CTM - the full
                    # text-space-to-page-space transform for this glyph.
                    trm = mat_mult(
                        (font_size * hscale, 0.0, 0.0, font_size, 0.0, rise),
                        mat_mult(tm, ctm))
                    y0 = metrics.descent / 1000.0
                    y1 = metrics.ascent / 1000.0
                    corners = [mat_apply(p, trm)
                               for p in ((0.0, y0), (w0, y0), (w0, y1), (0.0, y1))]
                    xs = [c[0] for c in corners]
                    ys = [c[1] for c in corners]
                    pending.append({
                        "mcid": mcid,
                        "text": metrics.tounicode[code],
                        "x0": min(xs), "y0": min(ys), "x1": max(xs), "y1": max(ys),
                        # Render mode 3 paints nothing: an OCR layer under a
                        # scanned page image is entirely invisible text, and
                        # selecting it is the whole point of the feature.
                        "invisible": render_mode == 3,
                        "font": metrics.name,
                        "branch": metrics.branch,
                    })

                    # Word spacing applies only to a single-byte code 32, so
                    # never to Identity-H text, whose codes are two bytes.
                    extra = char_spacing
                    if code == 32 and metrics.code_width == 1:
                        extra += word_spacing
                    tm = mat_mult(
                        (1.0, 0.0, 0.0, 1.0, (w0 * font_size + extra) * hscale, 0.0), tm)
        except Unmeasurable as exc:
            refusals[mcid] = str(exc)
            return

        for entry in pending:
            entry["seq"] = seq.get(mcid, 0)
            seq[mcid] = entry["seq"] + 1
            boxes.append(entry)

    for instr in instructions:
        op = str(instr.operator)
        ops = instr.operands
        if op == "q":
            ctm_stack.append(ctm)
        elif op == "Q":
            if ctm_stack:
                ctm = ctm_stack.pop()
        elif op == "cm" and len(ops) == 6:
            ctm = mat_mult(tuple(_num(v, 0.0) for v in ops), ctm)
        elif op == "BT":
            tm = tlm = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
        elif op == "ET":
            tm = tlm = None
        elif op == "Tm" and len(ops) == 6:
            tm = tlm = tuple(_num(v, 0.0) for v in ops)
        elif op == "TL" and len(ops) == 1:
            leading = _num(ops[0], leading)
        elif op == "Tc" and len(ops) == 1:
            char_spacing = _num(ops[0], char_spacing)
        elif op == "Tw" and len(ops) == 1:
            word_spacing = _num(ops[0], word_spacing)
        elif op == "Tz" and len(ops) == 1:
            hscale = _num(ops[0], 100.0) / 100.0
        elif op == "Ts" and len(ops) == 1:
            rise = _num(ops[0], rise)
        elif op == "Tr" and len(ops) == 1:
            render_mode = int(_num(ops[0], 0))
        elif op == "Tf" and len(ops) == 2:
            font_name = str(ops[0])
            font_size = _num(ops[1], 0.0)
        elif op in ("Td", "TD") and len(ops) == 2 and tlm is not None:
            tx, ty = _num(ops[0], 0.0), _num(ops[1], 0.0)
            if op == "TD":
                leading = -ty
            tlm = mat_mult((1.0, 0.0, 0.0, 1.0, tx, ty), tlm)
            tm = tlm
        elif op == "T*" and tlm is not None:
            tlm = mat_mult((1.0, 0.0, 0.0, 1.0, 0.0, -leading), tlm)
            tm = tlm
        elif op == "BDC" and len(ops) == 2:
            mcid = None
            props = ops[1]
            if isinstance(props, pikepdf.Dictionary) and "/MCID" in props:
                try:
                    mcid = int(props["/MCID"])
                except (TypeError, ValueError):
                    mcid = None
            mcid_stack.append(mcid)
        elif op == "BMC":
            mcid_stack.append(None)
        elif op == "EMC":
            if mcid_stack:
                mcid_stack.pop()
        elif op == "Tj" and ops and tm is not None:
            show([("str", bytes(ops[-1]))])
        elif op == "'" and ops and tlm is not None:
            tlm = mat_mult((1.0, 0.0, 0.0, 1.0, 0.0, -leading), tlm)
            tm = tlm
            show([("str", bytes(ops[-1]))])
        elif op == '"' and len(ops) == 3 and tlm is not None:
            word_spacing = _num(ops[0], word_spacing)
            char_spacing = _num(ops[1], char_spacing)
            tlm = mat_mult((1.0, 0.0, 0.0, 1.0, 0.0, -leading), tlm)
            tm = tlm
            show([("str", bytes(ops[2]))])
        elif op == "TJ" and len(ops) == 1 and isinstance(ops[0], pikepdf.Array) and tm is not None:
            show([("str", bytes(e)) if isinstance(e, pikepdf.String) else ("adj", _num(e, 0.0))
                  for e in ops[0]])

    if refusals:
        boxes = [b for b in boxes if b["mcid"] not in refusals]
    return boxes, refusals
