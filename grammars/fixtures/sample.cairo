use starknet::ContractAddress;

/// A counter anyone may read and only the owner may reset.
#[starknet::interface]
trait ICounter<TContractState> {
    fn get(self: @TContractState) -> u128;
    fn increase(ref self: TContractState, amount: u128);
}

#[starknet::contract]
mod Counter {
    use super::ICounter;
    use starknet::ContractAddress;

    #[storage]
    struct Storage {
        count: u128,
        owner: ContractAddress,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        Increased: Increased,
    }

    #[derive(Drop, starknet::Event)]
    struct Increased {
        amount: u128,
    }

    #[constructor]
    fn constructor(ref self: ContractState, owner: ContractAddress) {
        self.owner.write(owner);
    }

    #[abi(embed_v0)]
    impl CounterImpl of ICounter<ContractState> {
        fn get(self: @ContractState) -> u128 {
            self.count.read()
        }

        fn increase(ref self: ContractState, amount: u128) {
            assert(amount > 0_u128, 'amount must be positive');
            let total = self.count.read() + amount;
            self.count.write(total);
            self.emit(Increased { amount });
        }
    }
}
