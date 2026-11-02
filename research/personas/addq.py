"""Puts lines at the head of a lane's queue. addq.py <lane> <file-or-->"""
import sys
lane=sys.argv[1]; new=[x for x in open(sys.argv[2]).read().splitlines() if x.strip()]
q=open(f".cache/queue/{lane}.txt").read().splitlines()
open(f".cache/queue/{lane}.txt","w").write("\n".join(new+[x for x in q if x not in new])+"\n")
