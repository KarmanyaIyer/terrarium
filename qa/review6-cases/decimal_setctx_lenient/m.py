import decimal
def work():
    decimal.setcontext(decimal.Context(prec=10))
    return decimal.getcontext().prec
