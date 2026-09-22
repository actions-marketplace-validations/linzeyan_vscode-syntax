# @version ^0.4.0
# @notice A vault that pays out to whoever put money in.

owner: public(address)
balances: HashMap[address, uint256]

event Deposit:
    sender: indexed(address)
    amount: uint256

MAX_WITHDRAW: constant(uint256) = 10 ** 18


@deploy
def __init__():
    self.owner = msg.sender


@external
@payable
def deposit():
    """
    Credit the caller's balance with whatever they sent.
    """
    assert msg.value > 0, "nothing sent"
    self.balances[msg.sender] += msg.value
    log Deposit(msg.sender, msg.value)


@external
def withdraw(amount: uint256):
    assert amount <= MAX_WITHDRAW, "too much at once"
    self.balances[msg.sender] -= amount
    send(msg.sender, amount)


@external
@view
def balance_of(who: address) -> uint256:
    return self.balances[who]
