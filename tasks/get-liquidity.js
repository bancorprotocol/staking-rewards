const fs = require('fs');
const path = require('path');
const BN = require('bn.js');
const Contract = require('web3-eth-contract');
const { set, get } = require('lodash');

const { trace, info, error, warning, arg } = require('../utils/logger');
const DB = require('../utils/db');

const CONTRACTS_DIR = path.resolve(__dirname, '../node_modules/@bancor/contracts-solidity/solidity/build/contracts');

const ETH_RESERVE_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const MKR_RESERVE_ADDRESS = '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2';

const BATCH_SIZE = 500;

const getLiquidityTask = async (env) => {
    const getPosition = async (id, blockNumber) => {
        const position = await web3Provider.call(
            contracts.LiquidityProtectionStore.methods.protectedLiquidity(id),
            {},
            blockNumber
        );

        return {
            id,
            provider: position[0],
            poolToken: position[1],
            reserveToken: position[2],
            poolAmount: position[3],
            reserveAmount: position[4],
            reserveRateN: position[5],
            reserveRateD: position[6],
            timestamp: position[7]
        };
    };

    const getTokenInfo = async (token) => {
        const eq = (address1, address2) => {
            return address1.toLowerCase() === address2.toLowerCase();
        };

        let name;
        let symbol;
        if (eq(token, ETH_RESERVE_ADDRESS)) {
            name = 'Ethereum Reserve';
            symbol = 'ETH';
        } else if (eq(token, MKR_RESERVE_ADDRESS)) {
            name = 'MakerDAO';
            symbol = 'MKR';
        } else {
            const ERC20 = new Contract(ERC20_ABI, token);
            name = await web3Provider.call(ERC20.methods.name());
            symbol = await web3Provider.call(ERC20.methods.symbol());
        }

        return { name, symbol };
    };

    const getProtectionLiquidityChanges = async (data, fromBlock, toBlock) => {
        const { liquidity, pools, totalReserveAmounts, totalProviderAmounts } = data;

        let eventCount = 0;
        for (let i = fromBlock; i < toBlock; i += BATCH_SIZE) {
            const endBlock = Math.min(i + BATCH_SIZE - 1, toBlock);

            info(
                'Querying all protection change events from',
                arg('startBlock', i),
                'to',
                arg('endBlock', endBlock),
                'in batches of',
                arg('batchSize', BATCH_SIZE),
                'blocks'
            );

            const events = await web3Provider.getPastEvents(contracts.LiquidityProtectionStore, 'allEvents', {
                fromBlock: i,
                toBlock: endBlock
            });

            for (const event of events) {
                const { blockNumber, returnValues, transactionHash } = event;
                const block = await web3Provider.getBlock(blockNumber);
                const { timestamp } = block;

                switch (event.event) {
                    case 'ProtectionAdded': {
                        const provider = returnValues._provider;
                        const poolToken = returnValues._poolToken;
                        const reserveToken = returnValues._reserveToken;
                        const reserveAmount = returnValues._reserveAmount;

                        trace(
                            'Found ProtectionAdded event at block',
                            arg('blockNumber', blockNumber),
                            arg('provider', provider),
                            arg('poolToken', poolToken),
                            arg('reserveToken', reserveToken),
                            arg('reserveAmount', reserveAmount),
                            arg('timestamp', timestamp),
                            arg('tx', transactionHash)
                        );

                        liquidity.push({
                            event: 'Add',
                            blockNumber,
                            timestamp,
                            provider,
                            poolToken,
                            reserveToken,
                            reserveAmount: reserveAmount.toString()
                        });

                        if (!get(pools, [poolToken])) {
                            set(pools, [poolToken], await getTokenInfo(poolToken));
                        }

                        if (!get(pools, [poolToken, reserveToken])) {
                            set(pools, [poolToken, reserveToken], await getTokenInfo(reserveToken));
                        }

                        const totalReserveAmount = get(totalReserveAmounts, [poolToken, reserveToken]) || 0;
                        set(
                            totalReserveAmounts,
                            [poolToken, reserveToken],
                            new BN(totalReserveAmount).add(new BN(reserveAmount)).toString()
                        );

                        const totalProviderAmount = get(totalProviderAmounts, [provider, poolToken, reserveToken]) || 0;
                        set(
                            totalProviderAmounts,
                            [provider, poolToken, reserveToken],
                            new BN(totalProviderAmount).add(new BN(reserveAmount)).toString()
                        );

                        eventCount++;

                        data.lastBlockNumber = blockNumber;

                        break;
                    }

                    case 'ProtectionUpdated': {
                        const provider = returnValues._provider;
                        const prevReserveAmount = returnValues._prevReserveAmount;
                        const newReserveAmount = returnValues._newReserveAmount;
                        const prevPoolAmount = returnValues._prevPoolAmount;
                        const newPoolAmount = returnValues._newPoolAmount;

                        trace(
                            'Found ProtectionUpdated event at block',
                            arg('blockNumber', blockNumber),
                            arg('provider', provider),
                            arg('prevPoolAmount', prevPoolAmount),
                            arg('newPoolAmount', newPoolAmount),
                            arg('prevReserveAmount', prevReserveAmount),
                            arg('newReserveAmount', newReserveAmount),
                            arg('timestamp', timestamp),
                            arg('tx', transactionHash)
                        );

                        // Try to find the pool and reserves tokens by matching the position in a previous block.
                        // Please note that we are assuming that a single position wasn't added and removed in the
                        // same block.
                        const matches = [];
                        const prevBlock = blockNumber - 1;
                        let ids = await web3Provider.call(
                            contracts.LiquidityProtectionStore.methods.protectedLiquidityIds(provider),
                            {},
                            prevBlock
                        );
                        for (const id of ids) {
                            const position = await getPosition(id, prevBlock);
                            if (
                                new BN(position.reserveAmount).eq(new BN(prevReserveAmount)) &&
                                new BN(position.poolAmount).eq(new BN(prevPoolAmount))
                            ) {
                                matches.push({
                                    poolToken: position.poolToken,
                                    reserveToken: position.reserveToken
                                });
                            }
                        }

                        if (matches.length === 0) {
                            warning(
                                'Failed to fully match pool and reserve tokens. Trying to look for an updated position in the same block (assuming no more than a two updates in the same block)'
                            );

                            ids = await web3Provider.call(
                                contracts.LiquidityProtectionStore.methods.protectedLiquidityIds(provider),
                                {},
                                blockNumber
                            );
                            for (const id of ids) {
                                const position = await getPosition(id, blockNumber);
                                if (
                                    new BN(position.reserveAmount).eq(new BN(newReserveAmount)) &&
                                    new BN(position.poolAmount).eq(new BN(newPoolAmount))
                                ) {
                                    matches.push({
                                        poolToken: position.poolToken,
                                        reserveToken: position.reserveToken
                                    });
                                }
                            }

                            if (matches.length !== 1) {
                                error(
                                    'Failed to fully match pool and reserve tokens. Expected to find a single match, but found',
                                    arg('matches', matches.length)
                                );
                            }
                        } else if (matches.length !== 1) {
                            error(
                                'Failed to fully match pool and reserve tokens. Expected to find a single match, but found',
                                arg('matches', matches.length)
                            );
                        }

                        const { poolToken, reserveToken } = matches[0];

                        liquidity.push({
                            event: 'Remove',
                            blockNumber,
                            timestamp,
                            provider,
                            poolToken,
                            reserveToken,
                            reserveAmount: new BN(prevReserveAmount).sub(new BN(newReserveAmount)).toString()
                        });

                        const totalReserveAmount = get(totalReserveAmounts, [poolToken, reserveToken]) || 0;
                        set(
                            totalReserveAmounts,
                            [poolToken, reserveToken],
                            new BN(totalReserveAmount)
                                .add(new BN(newReserveAmount))
                                .sub(new BN(prevReserveAmount))
                                .toString()
                        );

                        const totalProviderAmount = get(totalProviderAmounts, [provider, poolToken, reserveToken]) || 0;
                        set(
                            totalProviderAmounts,
                            [provider, poolToken, reserveToken],
                            new BN(totalProviderAmount)
                                .add(new BN(newReserveAmount))
                                .sub(new BN(prevReserveAmount))
                                .toString()
                        );

                        eventCount++;

                        data.lastBlockNumber = blockNumber;

                        break;
                    }

                    case 'ProtectionRemoved': {
                        const provider = returnValues._provider;
                        const poolToken = returnValues._poolToken;
                        const reserveToken = returnValues._reserveToken;
                        const poolAmount = returnValues._poolAmount;
                        const reserveAmount = returnValues._reserveAmount;

                        trace(
                            'Found ProtectionRemoved event at block',
                            arg('blockNumber', blockNumber),
                            arg('provider', provider),
                            arg('poolToken', poolToken),
                            arg('reserveToken', reserveToken),
                            arg('poolAmount', poolAmount),
                            arg('reserveAmount', reserveAmount),
                            arg('timestamp', timestamp),
                            arg('tx', transactionHash)
                        );

                        liquidity.push({
                            event: 'Remove',
                            blockNumber,
                            timestamp,
                            provider,
                            poolToken,
                            reserveToken,
                            reserveAmount: reserveAmount.toString()
                        });

                        const totalReserveAmount = get(totalReserveAmounts, [poolToken, reserveToken]) || 0;
                        set(
                            totalReserveAmounts,
                            [poolToken, reserveToken],
                            new BN(totalReserveAmount).sub(new BN(reserveAmount)).toString()
                        );

                        const totalProviderAmount = get(totalProviderAmounts, [provider, poolToken, reserveToken]) || 0;
                        set(
                            totalProviderAmounts,
                            [provider, poolToken, reserveToken],
                            new BN(totalProviderAmount).sub(new BN(reserveAmount)).toString()
                        );

                        eventCount++;

                        data.lastBlockNumber = blockNumber;

                        break;
                    }
                }
            }
        }

        info('Finished processing all new protection change events', arg('count', eventCount));
    };

    const verifyProtectionLiquidityChanges = async (data, toBlock) => {
        const { liquidity, totalReserveAmounts, totalProviderAmounts } = data;

        info('Verifying all protection change events', arg('blockNumber', toBlock));

        // Verify that the events are sorted in an ascending order.
        for (let i = 0; i + 1 < liquidity.length; ++i) {
            const change1 = liquidity[i];
            const change2 = liquidity[i + 1];

            if (change1.blockNumber > change2.blockNumber || change1.timestamp > change2.timestamp) {
                error('Wrong events order', arg('change1', change1), arg('change2', change2));
            }
        }

        info('Verifying total reserve amounts', arg('blockNumber', toBlock));

        // Verify that the total reserve amounts correspond to the LiquidityProtectionStats contract.
        for (const [poolToken, reserveTokens] of Object.entries(totalReserveAmounts)) {
            for (const [reserveToken, amount] of Object.entries(reserveTokens)) {
                const actualAmount = await web3Provider.call(
                    contracts.LiquidityProtectionStats.methods.totalReserveAmount(poolToken, reserveToken),
                    {},
                    toBlock
                );

                if (!new BN(actualAmount).eq(new BN(amount))) {
                    error(
                        "Total reserve amounts don't match",
                        arg('poolToken', poolToken),
                        arg('reserveToken', reserveToken),
                        arg('expected', amount),
                        arg('actual', actualAmount)
                    );
                }
            }
        }

        info('Verifying total provider amounts', arg('blockNumber', toBlock));

        // Verify that the total provider amounts correspond to the LiquidityProtectionStats contract.
        for (const [provider, poolTokens] of Object.entries(totalProviderAmounts)) {
            for (const [poolToken, reserveTokens] of Object.entries(poolTokens)) {
                for (const [reserveToken, amount] of Object.entries(reserveTokens)) {
                    const actualAmount = await web3Provider.call(
                        contracts.LiquidityProtectionStats.methods.totalProviderAmount(
                            provider,
                            poolToken,
                            reserveToken
                        ),
                        {},
                        toBlock
                    );

                    if (!new BN(actualAmount).eq(new BN(amount))) {
                        error(
                            "Total provider amounts don't match",
                            arg('poolToken', poolToken),
                            arg('reserveToken', reserveToken),
                            arg('expected', amount),
                            arg('actual', actualAmount)
                        );
                    }
                }
            }
        }
    };

    const getProtectedLiquidity = async (data, fromBlock, toBlock) => {
        if (!data.liquidity) {
            data.liquidity = [];
        }

        if (!data.pools) {
            data.pools = {};
        }

        if (!data.totalReserveAmounts) {
            data.totalReserveAmounts = {};
        }

        if (!data.totalProviderAmounts) {
            data.totalProviderAmounts = {};
        }

        await getProtectionLiquidityChanges(data, fromBlock, toBlock);
        await verifyProtectionLiquidityChanges(data, toBlock);
    };

    const { settings, web3Provider, reorgOffset, contracts, test } = env;

    if (test) {
        warning('Please be aware that querying a forked mainnet is much slower than querying the mainnet directly');
    }

    const rawData = fs.readFileSync(path.join(CONTRACTS_DIR, 'ERC20.json'));
    const { abi: ERC20_ABI } = JSON.parse(rawData);

    const db = new DB('liquidity');

    let fromBlock;
    if (!db.data.lastBlockNumber) {
        warning('DB last block number is missing. Starting from the beginning');
        fromBlock = settings.genesisBlock;
    } else {
        fromBlock = db.data.lastBlockNumber + 1;
    }

    const latestBlock = await web3Provider.getBlockNumber();
    if (latestBlock === 0) {
        error('Node is out of sync. Please try again later');
    }

    const toBlock = latestBlock - reorgOffset;
    if (toBlock < fromBlock) {
        error('Invalid block range', arg('fromBlock', fromBlock), arg('toBlock', toBlock));
    }

    if (toBlock - fromBlock < reorgOffset) {
        error(
            'Unable to satisfy the reorg window. Please wait for additional',
            arg('blocks', reorgOffset - (toBlock - fromBlock + 1)),
            'to pass'
        );
    }

    info('Getting protected liquidity from', arg('fromBlock', fromBlock), 'to', arg('toBlock', toBlock));

    await getProtectedLiquidity(db.data, fromBlock, toBlock);

    db.save();
};

module.exports = getLiquidityTask;
