const fs = require('fs');
const path = require('path');
const BN = require('bn.js');
const { set } = require('lodash');

const { trace, info, error, warning, arg } = require('../utils/logger');

const getRewardsTask = async (env) => {
    const applyPositionChanges = async (liquidity, fromBlock, toBlock) => {
        let eventCount = 0;

        const pools = {};
        const providers = {};

        info('Applying all position change events from', arg('fromBlock', fromBlock), 'to', arg('toBlock', toBlock));

        for (const change of liquidity) {
            const { event, blockNumber, timestamp, provider, poolToken, reserveToken, reserveAmount } = change;

            if (blockNumber < fromBlock) {
                error('Invalid', arg('blockNumber', blockNumber), '. Aborting');
            }

            switch (event) {
                case 'Add': {
                    trace(
                        'Applying liquidity provision event from block',
                        arg('blockNumber', blockNumber),
                        arg('provider', provider),
                        arg('poolToken', poolToken),
                        arg('reserveToken', reserveToken),
                        arg('reserveAmount', reserveAmount),
                        arg('timestamp', timestamp)
                    );

                    set(pools, [poolToken, reserveToken], {});
                    set(providers, [provider, poolToken, reserveToken], {});

                    await web3Provider.send(contracts.TestStakingRewards.methods.setTime(timestamp));
                    await web3Provider.send(
                        contracts.TestLiquidityProtection.methods.addLiquidity(
                            provider,
                            poolToken,
                            reserveToken,
                            reserveAmount
                        )
                    );

                    eventCount++;

                    break;
                }

                case 'Remove': {
                    trace(
                        'Applying liquidity removal event at block',
                        arg('blockNumber', blockNumber),
                        arg('provider', provider),
                        arg('poolToken', poolToken),
                        arg('reserveToken', reserveToken),
                        arg('reserveAmount', reserveAmount),
                        arg('timestamp', timestamp)
                    );

                    await web3Provider.send(contracts.TestStakingRewards.methods.setTime(timestamp));
                    await web3Provider.send(
                        contracts.TestLiquidityProtection.methods.removeLiquidity(
                            provider,
                            poolToken,
                            reserveToken,
                            reserveAmount
                        )
                    );

                    eventCount++;

                    break;
                }
            }
        }

        info('Finished applying all new protection change events', arg('count', eventCount));

        return { pools, providers };
    };

    const getRewardsData = async (data) => {
        const rewards = {
            poolRewards: {},
            providerRewards: {}
        };

        let total = 0;
        let filtered = 0;

        const { pools, providers } = data;

        info('Processing all rewards');

        for (const [poolToken, reserveTokens] of Object.entries(pools)) {
            for (const reserveToken of Object.keys(reserveTokens)) {
                trace('Processing pool rewards', arg('poolToken', poolToken), arg('reserveToken', reserveToken));

                const data = await web3Provider.call(
                    contracts.StakingRewardsStore.methods.rewards(poolToken, reserveToken)
                );

                if (new BN(data[0]).eq(new BN(0))) {
                    filtered++;

                    continue;
                }

                set(rewards.poolRewards, [poolToken, reserveToken], {
                    lastUpdateTime: data[0],
                    rewardPerToken: data[1],
                    totalClaimedRewards: data[2]
                });

                total++;
            }
        }

        info('Finished processing all rewards', arg('total', total), arg('filtered', filtered));

        total = 0;
        filtered = 0;

        info('Processing all provider rewards');

        for (const [provider, poolTokens] of Object.entries(providers)) {
            for (const [poolToken, reserveTokens] of Object.entries(poolTokens)) {
                for (const reserveToken of Object.keys(reserveTokens)) {
                    trace(
                        'Processing provider rewards',
                        arg('provider', provider),
                        arg('poolToken', poolToken),
                        arg('reserveToken', reserveToken)
                    );

                    const data = await web3Provider.call(
                        contracts.StakingRewardsStore.methods.providerRewards(provider, poolToken, reserveToken)
                    );

                    if (new BN(data[0]).eq(new BN(0))) {
                        filtered++;

                        continue;
                    }

                    set(rewards.providerRewards, [provider, poolToken, reserveToken], {
                        rewardPerToken: data[0],
                        pendingBaseRewards: data[1],
                        totalClaimedRewards: data[2],
                        effectiveStakingTime: data[3],
                        baseRewardsDebt: data[4],
                        baseRewardsDebtMultiplier: data[5]
                    });

                    total++;
                }
            }
        }

        info('Finished processing all provider rewards', arg('total', total), arg('filtered', filtered));

        return rewards;
    };

    // TODO: set everything and then rerun?
    const verifyRewards = async (liquidity, toBlock) => {
        // info('Verifying all reserve amounts at', arg('blockNumber', toBlock));
        // for (const [poolToken, poolTokenData] of Object.entries(liquidity)) {
        //     for (const [reserveToken, data] of Object.entries(poolTokenData.reserveTokens)) {
        //         trace('Verifying', arg('poolToken', poolToken), arg('reserveToken', reserveToken));
        //         const { reserveAmount } = data;
        //         const actualAmount = await web3Provider.call(
        //             contracts.LiquidityProtectionStoreOld.methods.totalProtectedReserveAmount(poolToken, reserveToken),
        //             {},
        //             toBlock
        //         );
        //         if (!new BN(reserveAmount).eq(new BN(actualAmount))) {
        //             error(
        //                 'Wrong liquidity',
        //                 arg('poolToken', poolToken),
        //                 arg('reserveToken', reserveToken),
        //                 '[',
        //                 arg('expected', reserveAmount),
        //                 arg('actual', actualAmount),
        //                 ']'
        //             );
        //         }
        //         const { snapshots } = data;
        //         for (const snapshot of snapshots) {
        //             const { blockNumber, timestamp, reserveAmount } = snapshot;
        //             // Verify snapshot values.
        //             const actualSnapshotAmount = await web3Provider.call(
        //                 contracts.LiquidityProtectionStoreOld.methods.totalProtectedReserveAmount(
        //                     poolToken,
        //                     reserveToken
        //                 ),
        //                 {},
        //                 blockNumber
        //             );
        //             if (!new BN(actualSnapshotAmount).eq(new BN(reserveAmount))) {
        //                 error(
        //                     'Wrong snapshot liquidity',
        //                     arg('poolToken', poolToken),
        //                     arg('reserveToken', reserveToken),
        //                     arg('blockNumber', blockNumber),
        //                     arg('timestamp', reserveToken),
        //                     '[',
        //                     arg('expected', reserveAmount),
        //                     arg('actual', actualSnapshotAmount),
        //                     ']'
        //                 );
        //             }
        //             // Verify snapshot timestamps.
        //             const block = await web3Provider.getBlock(blockNumber);
        //             const { timestamp: blockTimeStamp } = block;
        //             if (timestamp != blockTimeStamp) {
        //                 error(
        //                     'Wrong snapshot timestamp',
        //                     arg('poolToken', poolToken),
        //                     arg('reserveToken', reserveToken),
        //                     arg('blockNumber', blockNumber),
        //                     arg('timestamp', reserveToken),
        //                     '[',
        //                     arg('expected', timestamp),
        //                     arg('actual', blockTimeStamp),
        //                     ']'
        //                 );
        //             }
        //         }
        //         // Verify that the snapshots array is sorted in an ascending order.
        //         for (let i = 0; i + 1 < snapshots.length - 1; ++i) {
        //             const snapshot1 = snapshots[i];
        //             const snapshot2 = snapshots[i + 1];
        //             if (snapshot1.timestamp > snapshot2.timestamp) {
        //                 error(
        //                     'Wrong snapshots order',
        //                     arg('poolToken', poolToken),
        //                     arg('reserveToken', reserveToken),
        //                     arg('snapshot1', snapshot1),
        //                     arg('snapshot2', snapshot2)
        //                 );
        //             }
        //         }
        //     }
        // }
    };

    const getRewards = async (liquidity, fromBlock, toBlock) => {
        info('Getting all rewards from', arg('fromBlock', fromBlock), 'to', arg('toBlock', toBlock));

        const data = await applyPositionChanges(liquidity.liquidity, fromBlock, toBlock);
        const rewards = await getRewardsData(data, toBlock);

        // await verifyRewards(rewards);

        return rewards;
    };

    const { settings, web3Provider, contracts, test, init } = env;

    if (!test || !init) {
        error('Getting all rewards is only possible in test and init modes. Aborting');
    }

    warning('Please be aware that querying a forked mainnet is much slower than querying the mainnet directly');

    const dbDir = path.resolve(__dirname, '../data');
    const liquidityDbPath = path.join(dbDir, 'liquidity.json');
    const rawData = fs.readFileSync(liquidityDbPath);
    const liquidity = JSON.parse(rawData);

    const fromBlock = settings.genesisBlock;
    const toBlock = liquidity.lastBlockNumber;

    const rewards = await getRewards(liquidity, fromBlock, toBlock);

    const rewardsDbPath = path.join(dbDir, 'rewards.json');
    fs.writeFileSync(rewardsDbPath, JSON.stringify(rewards, null, 2));
};

module.exports = getRewardsTask;
