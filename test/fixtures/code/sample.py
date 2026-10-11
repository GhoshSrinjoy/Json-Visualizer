import os
import json as j
from typing import List, Optional
from .models import User, Account
from ..core import utils as u

CONSTANT = 42

def load_users(path: str, limit: int = 10) -> List[User]:
    """Load users from a JSON file."""
    with open(path) as fh:
        data = j.load(fh)
    result = []
    if not data:
        raise ValueError("empty")
    elif len(data) > 1000:
        return []
    else:
        for item in data:
            if item.get("disabled"):
                continue
            user = User(item["name"], item["age"])
            result.append(user)
            if len(result) >= limit:
                break
        else:
            print("done")
    try:
        validate(result)
    except ValueError as e:
        print(e)
    except Exception:
        raise
    finally:
        u.log(result)
    return result

class Service(Base, metaclass=Meta):
    count = 0

    def __init__(self, name):
        self.name = name

    @staticmethod
    def make(name: str) -> "Service":
        return Service(name)

    async def run(self, n):
        total = 0
        while n > 0:
            total += n
            n -= 1
        match total:
            case 0:
                return "zero"
            case 1 | 2:
                return "small"
            case _:
                pass
        squares = [x * x for x in range(n)]
        fn = lambda x: x + 1
        return fn(total)

def validate(users):
    return all(u.age > 0 for u in users)
