const { toWei, fromWei } = require('web3-utils');
const Web3 = require('web3');
const Contract = require('web3-eth-contract');
const ganache = require('ganache-core');
const memdown = require('memdown');

const { info, error, arg } = require('./logger');

const settings = require('../settings.json');
const providers = require('../providers.json');

const GAS_LIMIT_BUFFER = 0.2; // 20%

class Provider {
    async initialize({ test, gasPrice }) {
        this.test = test;
        this.privateKey = require('../credentials.json').privateKey;

        const { WebsocketProvider, HttpProvider } = providers;

        if (!this.test) {
            info('Running against mainnet');

            this.queryWeb3 = new Web3(WebsocketProvider);
            this.sendWeb3 = new Web3(HttpProvider);
        } else {
            info('Running against a mainnet fork (via Ganache)');

            const ganacheProvider = ganache.provider({
                fork: WebsocketProvider,
                accounts: [{ secretKey: this.privateKey, balance: 10000000000000000000 }],
                ws: true,
                network_id: 1,
                db: memdown(),
                default_balance_ether: 10000000000000000000,
                unlocked_accounts: Provider.unlockedAccounts()
            });

            info('Started forking the mainnet');

            const web3 = new Web3(ganacheProvider);
            this.queryWeb3 = web3;
            this.sendWeb3 = web3;

            info('Finished forking the mainnet');
        }

        const account = this.queryWeb3.eth.accounts.privateKeyToAccount(this.privateKey);
        this.defaultAccount = account.address;

        this.queryWeb3.eth.accounts.wallet.add(account);
        this.sendWeb3.eth.accounts.wallet.add(account);

        if (gasPrice) {
            this.gasPrice = toWei((gasPrice || 0).toString(), 'gwei');

            info(
                'Default price is set to',
                arg('gasPrice', this.gasPrice),
                '(wei)',
                arg('gasPrice', fromWei(this.gasPrice.toString(), 'gwei')),
                '(gwei)'
            );
        }

        Contract.setProvider(this.queryWeb3);
    }

    getDefaultAccount() {
        return this.defaultAccount;
    }

    async call(method, options = {}, blockNumber) {
        Contract.setProvider(this.queryWeb3);

        return method.call(options, blockNumber);
    }

    async send(method, options = {}) {
        Contract.setProvider(this.sendWeb3);

        if (!options.gasPrice) {
            if (!this.test && (!this.gasPrice || Number(this.gasPrice) === 0)) {
                error("Gas price isn't set. Aborting");
            }

            options.gasPrice = this.gasPrice;
        }

        if (this.test) {
            if (!options.from) {
                options.from = this.defaultAccount;
            }

            if (!options.gas) {
                options.gas = await method.estimateGas(options);

                // Increase the gas limit by 10% (just to be on the safe side).
                options.gas = Math.ceil(options.gas * (1 + GAS_LIMIT_BUFFER));
            }

            return method.send(options);
        }

        if (options.from) {
            error('Can only send using the deployer. Aborting');
        }

        options.from = this.defaultAccount;

        if (!options.gas) {
            options.gas = await method.estimateGas(options);

            // Increase the gas limit by 10% (just to be on the safe side).
            options.gas = Math.ceil(options.gas * (1 + GAS_LIMIT_BUFFER));
        }

        const tx = {
            from: options.from,
            to: method._parent._address,
            gas: options.gas,
            gasPrice: options.gasPrice,
            value: options.value,
            data: method.encodeABI()
        };

        const signedTx = await this.sendWeb3.eth.accounts.signTransaction(tx, this.privateKey);

        return this.sendWeb3.eth.sendSignedTransaction(signedTx.raw || signedTx.rawTransaction);
    }

    async getBlock(blockNumber) {
        return this.queryWeb3.eth.getBlock(blockNumber);
    }

    async getBlockNumber() {
        return this.queryWeb3.eth.getBlockNumber();
    }

    async getLastBlock() {
        return this.getBlock(await this.getBlockNumber());
    }

    async getTransaction(transactionHash) {
        return this.queryWeb3.eth.getTransaction(transactionHash);
    }

    async getPastEvents(contract, event, options = {}) {
        Contract.setProvider(this.queryWeb3);

        return contract.getPastEvents(event, options);
    }

    decodeParameters(typesArray, hexString) {
        return this.queryWeb3.eth.abi.decodeParameters(typesArray, hexString);
    }

    static unlockedAccounts() {
        const {
            externalContracts: {
                LiquidityProtectionStore: { owner: liquidityProtectionStoreOwner },
                LiquidityProtection: { owner: liquidityProtectionOwner },
                TokenGovernance: { governor },
                CheckpointStore: { owner: checkpointStoreOwner },
                ContractRegistry: { owner: contractRegistryOwner }
            },
            systemContracts: {
                StakingRewardsStore: { supervisor: stakingRewardsStoreSupervisor }
            }
        } = settings;

        return [
            liquidityProtectionStoreOwner,
            liquidityProtectionOwner,
            governor,
            checkpointStoreOwner,
            contractRegistryOwner,
            stakingRewardsStoreSupervisor
        ];
    }
}

module.exports = Provider;
