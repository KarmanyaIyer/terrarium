inner = []
t = frozenset((id(inner),))  # plain
u = (inner,)
def box():
    return (u, u)
