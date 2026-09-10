"""
standard_fonts.py

Widths for a simple font that carries no /Widths of its own.

The PDF spec lets the 14 standard fonts omit their metrics entirely, on the
grounds that every viewer already has Adobe's AFM tables. pikepdf doesn't, so
without this glyph_metrics.py can't place a single character of such a font
and has to refuse the whole span - which is a visible inconsistency, because
split_leaf() will happily divide that same text: decoding needs only
/ToUnicode, while *placing* needs widths.

Getting from a character code to a width takes two lookups, and this module
is the two of them:

    code --(the font's encoding)--> glyph name --(the AFM table)--> width

Neither step guesses. The encoding comes from the font's own /Encoding (a
predefined name, or a dictionary with a /BaseEncoding and /Differences), or
from the font's built-in encoding when it says nothing - StandardEncoding for
the text faces, and their own symbol sets for Symbol and ZapfDingbats, which
are not Latin fonts and share no glyph names with them. A code the encoding
leaves empty, or a glyph the AFM table doesn't list, raises rather than
falling back to a plausible number: a wrong width doesn't fail loudly, it
silently shifts every character after it on the line.

The tables themselves are generated, not transcribed - see
standard_fonts_data.py and scripts/generate-standard-fonts.mjs.
"""

import pikepdf

from standard_fonts_data import ENCODINGS, WIDTHS


class UnknownStandardFont(Exception):
    """This font isn't one whose metrics we can supply."""


# Names a /BaseFont may use for a font that is a standard-14 face by another
# name. Deliberately short: these are the substitutions every viewer already
# makes (Arial and Helvetica are metrically identical by design, as are Times
# New Roman and Times), not a general "looks close enough" list. Anything not
# here, and not one of the 14, is refused rather than approximated.
_ALIASES = {
    "Arial": "Helvetica",
    "Arial-Bold": "Helvetica-Bold",
    "Arial-BoldItalic": "Helvetica-BoldOblique",
    "Arial-Italic": "Helvetica-Oblique",
    "ArialMT": "Helvetica",
    "Arial-BoldMT": "Helvetica-Bold",
    "Arial-BoldItalicMT": "Helvetica-BoldOblique",
    "Arial-ItalicMT": "Helvetica-Oblique",
    "CourierNew": "Courier",
    "CourierNewPSMT": "Courier",
    "CourierNew-Bold": "Courier-Bold",
    "CourierNew-BoldItalic": "Courier-BoldOblique",
    "CourierNew-Italic": "Courier-Oblique",
    "Helvetica-Italic": "Helvetica-Oblique",
    "Helvetica-BoldItalic": "Helvetica-BoldOblique",
    "TimesNewRoman": "Times-Roman",
    "TimesNewRomanPSMT": "Times-Roman",
    "TimesNewRomanPS-BoldMT": "Times-Bold",
    "TimesNewRomanPS-BoldItalicMT": "Times-BoldItalic",
    "TimesNewRomanPS-ItalicMT": "Times-Italic",
    "Times": "Times-Roman",
    "Times-Regular": "Times-Roman",
}

# The two symbolic faces have their own built-in encodings and share no glyph
# names with the Latin text faces, so they can never fall back to Standard.
_BUILTIN_ENCODING = {
    "Symbol": "SymbolSetEncoding",
    "ZapfDingbats": "ZapfDingbatsEncoding",
}


def canonical_name(base_font):
    """The standard-14 name `base_font` refers to, or None.

    Strips the `ABCDEF+` prefix a subsetted font carries - though a subset of
    a standard font is unusual, since subsetting implies the program is
    embedded, and an embedded font brings its own /Widths.
    """
    if not base_font:
        return None
    name = str(base_font).lstrip("/")
    if len(name) > 7 and name[6] == "+":
        name = name[7:]
    if name in WIDTHS:
        return name
    return _ALIASES.get(name)


def _encoding_vector(font, canonical):
    """The 256 glyph names this font's codes map to.

    /Encoding may be absent (use the font's built-in encoding), a predefined
    name, or a dictionary carrying an optional /BaseEncoding plus a
    /Differences array that overrides individual codes.
    """
    builtin = _BUILTIN_ENCODING.get(canonical, "StandardEncoding")
    encoding = font.get("/Encoding")

    def named(value):
        name = str(value).lstrip("/")
        if name not in ENCODINGS:
            raise UnknownStandardFont(f"Unsupported encoding: /{name}")
        return list(ENCODINGS[name])

    if encoding is None:
        return list(ENCODINGS[builtin])
    if isinstance(encoding, pikepdf.Name):
        return named(encoding)
    if not isinstance(encoding, pikepdf.Dictionary):
        raise UnknownStandardFont("This font's encoding isn't recognized")

    base = encoding.get("/BaseEncoding")
    vector = named(base) if base is not None else list(ENCODINGS[builtin])

    differences = encoding.get("/Differences")
    if differences is not None:
        if not isinstance(differences, pikepdf.Array):
            raise UnknownStandardFont("This font's /Differences isn't an array")
        code = 0
        for item in differences:
            # The array alternates: a number sets the next code to assign,
            # and each name after it takes one code in turn.
            if isinstance(item, pikepdf.Name):
                if 0 <= code < 256:
                    vector[code] = str(item).lstrip("/")
                code += 1
                continue
            try:
                code = int(item)
            except (TypeError, ValueError):
                raise UnknownStandardFont(
                    "This font's /Differences has an entry that is neither a code nor a name")
    return vector


def widths_for(font):
    """{code: width} for a simple font with no /Widths, in 1/1000 em.

    Raises UnknownStandardFont if this isn't a standard-14 face, or if its
    encoding names a glyph the AFM table doesn't have a width for.
    """
    canonical = canonical_name(font.get("/BaseFont"))
    if canonical is None:
        raise UnknownStandardFont(
            "Simple font with no /Widths, and its /BaseFont isn't one of the 14 standard fonts")

    table = WIDTHS[canonical]
    if isinstance(table, (int, float)):
        # A monospaced Courier face: every code the encoding defines is the
        # same width, and codes it doesn't define stay absent so an
        # unencoded byte is still reported rather than silently drawn.
        vector = _encoding_vector(font, canonical)
        return {code: float(table) for code, name in enumerate(vector) if name}

    vector = _encoding_vector(font, canonical)
    widths = {}
    for code, glyph in enumerate(vector):
        if not glyph:
            continue
        width = table.get(glyph)
        if width is not None:
            widths[code] = float(width)
    if not widths:
        raise UnknownStandardFont("This font's encoding produced no usable widths")
    return widths
