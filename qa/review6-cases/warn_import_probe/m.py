import warnings
warnings.filterwarnings("ignore", category=UserWarning)
def work():
    warnings.warn("boom", UserWarning)
    return 1
