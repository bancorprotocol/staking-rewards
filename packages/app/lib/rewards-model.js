const fs = require('fs');
const path = require('path');
const BN = require('bn.js');
const Contract = require('web3-eth-contract');

const ETH_RESERVE_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const MKR_RESERVE_ADDRESS = '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2';

class RewardsModel {
    constructor(web3Provider) {
        c = web3Provider;

        const dbDir = path.resolve(__dirname, '../data');
        this.dbPath = path.join(dbDir, 'rewards.json');
        let data = {};
        if (fs.existsSync(this.dbPath)) {
            const rawData = fs.readFileSync(this.dbPath);
            data = JSON.parse(rawData);
        }

        ({
            lastBlockNumber: this.lastBlockNumber,
            poolRewards: this.poolRewards = {},
            providerRewards: this.providerRewards = {},
            liquidity: this.liquidity = {},
            pools: this.pools = {},
            providerPools: this.providerPools = {}
        } = rewards);
    }

    save(blockNumber) {
        this.lastBlockNumber = blockNumber;

        fs.writeFileSync(
            this.dbPath,
            JSON.stringify(
                {
                    lastBlockNumber: this.lastBlockNumber,
                    poolRewards: this.poolRewards,
                    providerRewards: this.providerRewards,
                    liquidity: this.liquidity,
                    pools: this.pools,
                    providerPools: this.providerPools
                },
                null,
                2
            )
        );
    }

    getLastBlockNumber() {
        return this.lastBlockNumber;
    }

    async addLiquidity(provider, poolToken, reserveToken, reserveAmount) {
        this.addProviderLiquidity(provider, poolToken, reserveToken, reserveAmount);
    }

    async removeLiquidity(provider, poolToken, reserveToken, reserveAmount) {
        this.removeProviderLiquidity(provider, poolToken, reserveToken, reserveAmount);
    }

    async addProviderLiquidity(provider, poolToken, reserveToken, reserveAmount) {
        if (!this.pools[poolToken]) {
            this.pools[poolToken] = await getTokenInfo(poolToken);
        }

        if (!this.pools[poolToken][reserveToken]) {
            this.pools[poolToken][reserveToken] = await getTokenInfo(reserveToken);
        }

        if (!this.providerPools[provider][poolToken]) {
            this.providerPools[provider][poolToken] = [];
        }

        const reserveTokens = this.providerPools[provider][poolToken];
        if (!reserveTokens.includes(reserveToken)) {
            reserveTokens.push(reserveToken);
        }

        const { reserveAmounts, totalReserveAmounts } = this.liquidity;

        reserveAmounts[poolToken][reserveToken][provider] = (
            reserveAmounts[poolToken][reserveToken][provider] || new BN(0)
        ).add(reserveAmount);

        totalReserveAmounts[poolToken][reserveToken] = (totalReserveAmounts[poolToken][reserveToken] || new BN(0)).add(
            reserveAmount
        );
    }

    async removeProviderLiquidity(provider, poolToken, reserveToken, reserveAmount) {
        const { reserveAmounts, totalReserveAmounts } = this.liquidity;

        reserveAmounts[poolToken][reserveToken][provider] = reserveAmounts[poolToken][reserveToken][provider].sub(
            reserveAmount
        );

        totalReserveAmounts[poolToken][reserveToken] = totalReserveAmounts[poolToken][reserveToken].sub(reserveAmount);
    }

    async getTokenInfo(token) {
        let name;
        let symbol;
        if (token === ETH_RESERVE_ADDRESS) {
            name = 'Ethereum Reserve';
            symbol = 'ETH';
        } else if (token === MKR_RESERVE_ADDRESS) {
            name = 'MakerDAO';
            symbol = 'MKR';
        } else {
            const ERC20Token = new Contract(ERC20, token);
            name = await this.web3Provider.call(ERC20Token.methods.name());
            symbol = await this.web3Provider.call(ERC20Token.methods.symbol());
        }

        return { name, symbol };
    }
}

module.exports = RewardsModel;
