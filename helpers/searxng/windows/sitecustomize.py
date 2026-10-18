import os
if not hasattr(os, "getuid"): os.getuid = lambda: 0
if not hasattr(os, "geteuid"): os.geteuid = lambda: 0
