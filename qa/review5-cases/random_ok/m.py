import random


def roll(n):
    return [random.randint(1, 6) for _ in range(n)]


def reseed(x):
    random.seed(x)


def gauss_once():
    return random.gauss(0, 1)
