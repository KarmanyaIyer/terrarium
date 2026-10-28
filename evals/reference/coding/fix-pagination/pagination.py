"""List pagination helpers. Pages are numbered from 1."""


def total_pages(count, per_page):
    """Number of pages needed to show `count` items, `per_page` at a time.

    0 items need 0 pages. per_page must be at least 1, otherwise raise ValueError.
    """
    if per_page < 1:
        raise ValueError("per_page must be >= 1")
    return -(-count // per_page)


def paginate(items, page, per_page):
    """Return the list of items shown on page `page` (1-based).

    Pages past the end return an empty list. page must be at least 1 and per_page at
    least 1, otherwise raise ValueError.
    """
    if page < 1 or per_page < 1:
        raise ValueError("page and per_page must be >= 1")
    start = (page - 1) * per_page
    return items[start:start + per_page]
