def slugify(text, max_length=None):
    """Turn `text` into a URL slug.

    Rules, applied in this order:
    1. Accented letters become their plain ASCII letter ("é" -> "e", "Ö" -> "O").
       Any other non-ASCII character is dropped.
    2. Everything is lowercased.
    3. Every run of one or more characters that are not a-z or 0-9 becomes a single "-".
    4. Leading and trailing "-" are removed.
    5. If max_length is given and the slug is longer than max_length, keep as many whole
       "-"-separated words from the start as fit within max_length characters. If not even
       the first word fits, return the first max_length characters of the first word.

    Examples:
        slugify("Héllo, Wörld!")                 -> "hello-world"
        slugify("The quick brown fox", 12)       -> "the-quick"
        slugify("Supercalifragilistic", 5)       -> "super"
    """
    raise NotImplementedError
