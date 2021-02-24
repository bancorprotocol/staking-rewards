const fs = require('fs');
const BN = require('bn.js');
const { set } = require('lodash');

const { trace, info, error, warning, arg } = require('../utils/logger');
const DB = require('../utils/db');

const BATCH_SIZE = 500;

const getPoolPendingRewardsTask = async (env, { poolToken }) => {
    const eq = (address1, address2) => {
        return address1.toLowerCase() === address2.toLowerCase();
    };

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

    const getProtectionLiquidityChanges = async (data, targetPoolToken, fromBlock, toBlock) => {
        const pool = {};

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

                        trace(
                            'Found ProtectionAdded event at block',
                            arg('blockNumber', blockNumber),
                            arg('provider', provider),
                            arg('poolToken', poolToken),
                            arg('timestamp', timestamp),
                            arg('tx', transactionHash)
                        );

                        if (!eq(poolToken, targetPoolToken)) {
                            continue;
                        }

                        set(pool, [provider, poolToken, reserveToken], {});

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

                        if (!eq(poolToken, targetPoolToken)) {
                            continue;
                        }

                        set(pool, [provider, poolToken, reserveToken], {});

                        eventCount++;

                        data.lastBlockNumber = blockNumber;

                        break;
                    }

                    case 'ProtectionRemoved': {
                        const provider = returnValues._provider;
                        const poolToken = returnValues._poolToken;
                        const reserveToken = returnValues._reserveToken;

                        trace(
                            'Found ProtectionRemoved event at block',
                            arg('blockNumber', blockNumber),
                            arg('provider', provider),
                            arg('poolToken', poolToken),
                            arg('timestamp', timestamp),
                            arg('tx', transactionHash)
                        );

                        if (!eq(poolToken, targetPoolToken)) {
                            continue;
                        }

                        set(pool, [provider, poolToken, reserveToken], {});

                        eventCount++;

                        data.lastBlockNumber = blockNumber;

                        break;
                    }
                }
            }
        }

        info('Finished processing all new protection change events', arg('count', eventCount));

        return pool;
    };

    const getPendingRewards = async (data, pool, toBlock) => {
        info('Querying all pending rewards at block', arg('toBlock', toBlock));

        const { pendingRewards = {} } = data;

        console.log(pool);
        for (const [provider, poolTokens] of Object.entries(pool)) {
            for (const [poolToken, reserveTokens] of Object.entries(poolTokens)) {
                for (const reserveToken of Object.keys(reserveTokens)) {
                    const rewards = await web3Provider.call(
                        contracts.StakingRewards.methods.pendingReserveRewards(provider, poolToken, reserveToken)
                    );

                    if (new BN(rewards).eq(new BN(0))) {
                        trace(
                            'Skipping provider without pending rewards',
                            arg('provider', provider),
                            arg('poolToken', poolToken),
                            arg('reserveToken', reserveToken)
                        );

                        continue;
                    }

                    trace(
                        'Storing pool pending rewards for',
                        arg('provider', provider),
                        arg('poolToken', poolToken),
                        arg('reserveToken', reserveToken),
                        arg('rewards', rewards)
                    );

                    set(pendingRewards, [provider, poolToken, reserveToken], rewards);
                }
            }
        }
    };

    const getPoolPendingRewards = async (data, targetPoolToken, fromBlock, toBlock) => {
        if (!data.pendingRewards) {
            data.pendingRewards = {};
        }

        const pools = await getProtectionLiquidityChanges(data, targetPoolToken, fromBlock, toBlock);
        await getPendingRewards(data, pools, toBlock);
    };

    const { settings, web3Provider, reorgOffset, contracts, test } = env;

    if (test) {
        warning('Please be aware that querying a forked mainnet is much slower than querying the mainnet directly');
    }

    if (!poolToken) {
        error('Invalid pool token address');
    }

    const db = new DB(`pending-rewards-${poolToken}`);

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

    info(
        'Getting pending',
        arg('poolToken', poolToken),
        'rewards from',
        arg('fromBlock', fromBlock),
        'to',
        arg('toBlock', toBlock)
    );

    await getPoolPendingRewards(db.data, poolToken, fromBlock, toBlock);

    db.save();
};

module.exports = getPoolPendingRewardsTask;
