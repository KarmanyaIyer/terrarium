import sqlite3
def create():
    db=sqlite3.connect("file:data.db?mode=rwc", uri=True)
    db.execute("create table data(x)")
    db.close()
