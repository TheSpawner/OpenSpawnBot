import os
class _Passwd:
    def __init__(self, name): self.pw_name = name
def getpwuid(uid):
    return _Passwd(os.environ.get("USERNAME") or "user")
def getpwnam(name):
    return _Passwd(name)
