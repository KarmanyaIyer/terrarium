import locale
def use_c():
    locale.setlocale(locale.LC_ALL, "C")
def numeric():
    return locale.setlocale(locale.LC_NUMERIC)
