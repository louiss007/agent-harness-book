"""评测用的迷你应用。"""
TOKEN = "sk-live-123"

def add(a, b):
    return a + b

def sub(a, b):
    return a - b

def mul(a, b):
    return a * b

def div(a, b):
    return a / b

def clamp(value, low, high):
    # TODO: 输入校验
    if value < low:
        return low
    if value > high:
        return high
    return value

def describe(value):
    if value > 0:
        return "positive"
    if value < 0:
        return "negative"
    return "zero"

def main():
    print(add(1, 2))

if __name__ == "__main__":
    main()
