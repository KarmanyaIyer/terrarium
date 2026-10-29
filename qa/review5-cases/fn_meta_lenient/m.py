def f(x):
    """Doubles x."""
    # Bug: renames itself on first use.
    f.__name__ = "used"
    f.__doc__ = None
    return 2 * x
