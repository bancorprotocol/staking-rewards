const fs = require('fs');
const path = require('path');
const BN = require('bn.js');
const { set } = require('lodash');

const { trace, info, error, warning, arg } = require('../utils/logger');

const getRewardsTask = async (env, resume = false) => {
    const isPoolParticipating = (poolToken) => {
        return programs.findIndex((p) => p.poolToken.toLowerCase() === poolToken.toLowerCase()) !== -1;
    };

    const applyPositionChanges = async (liquidity, fromBlock, toBlock) => {
        let eventCount = 0;

        const poolRewards = {};
        const providerRewards = {};

        info('Applying all position change events from', arg('fromBlock', fromBlock), 'to', arg('toBlock', toBlock));

        for (const change of liquidity) {
            const { event, blockNumber, timestamp, provider, poolToken, reserveToken, reserveAmount } = change;

            if (blockNumber < fromBlock) {
                continue;
            }

            if (blockNumber > toBlock) {
                break;
            }

            if (!isPoolParticipating(poolToken)) {
                trace('Skipping non-participating', arg('poolToken', poolToken));

                continue;
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

                    set(poolRewards, [poolToken, reserveToken], {});
                    set(providerRewards, [poolToken, reserveToken, provider], {});

                    await web3Provider.send(
                        contracts.TestLiquidityProtectionSimulator.methods.simulateAddLiquidity(
                            provider,
                            poolToken,
                            reserveToken,
                            reserveAmount,
                            timestamp
                        )
                    );

                    eventCount++;

                    break;
                }

                case 'Remove': {
                    const { id, portion } = change;

                    trace(
                        'Applying liquidity removal event at block',
                        arg('blockNumber', blockNumber),
                        arg('id', id),
                        arg('portion', portion),
                        arg('provider', provider),
                        arg('poolToken', poolToken),
                        arg('reserveToken', reserveToken),
                        arg('reserveAmount', reserveAmount),
                        arg('timestamp', timestamp)
                    );

                    await web3Provider.send(
                        contracts.TestLiquidityProtectionSimulator.methods.simulateRemoveLiquidity(
                            provider,
                            poolToken,
                            reserveToken,
                            reserveAmount,
                            timestamp
                        )
                    );

                    eventCount++;

                    break;
                }
            }
        }

        info('Finished applying all new protection change events', arg('count', eventCount));

        return { poolRewards, providerRewards };
    };

    const getRewardsData = async (data) => {
        const rewards = {
            poolRewards: {},
            providerRewards: {}
        };

        let total = 0;
        let filtered = 0;

        const { poolRewards, providerRewards } = data;

        info('Processing all rewards');

        for (const [poolToken, reserveTokens] of Object.entries(poolRewards)) {
            for (const reserveToken of Object.keys(reserveTokens)) {
                trace('Processing pool rewards', arg('poolToken', poolToken), arg('reserveToken', reserveToken));

                const data = await web3Provider.call(
                    contracts.StakingRewardsStore.methods.poolRewards(poolToken, reserveToken)
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

        for (const [poolToken, reserveTokens] of Object.entries(providerRewards)) {
            for (const [reserveToken, providers] of Object.entries(reserveTokens)) {
                for (const provider of Object.keys(providers)) {
                    const data = await web3Provider.call(
                        contracts.StakingRewardsStore.methods.providerRewards(provider, poolToken, reserveToken)
                    );

                    if (new BN(data[0]).eq(new BN(0))) {
                        trace(
                            'Skipping provider rewards',
                            arg('provider', provider),
                            arg('poolToken', poolToken),
                            arg('reserveToken', reserveToken)
                        );

                        filtered++;

                        continue;
                    }

                    trace(
                        'Processing provider rewards',
                        arg('provider', provider),
                        arg('poolToken', poolToken),
                        arg('reserveToken', reserveToken)
                    );

                    set(rewards.providerRewards, [poolToken, reserveToken, provider], {
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

    const getPendingRewards = async (providerRewards) => {
        const pendingRewards = {};

        info('Getting all provider pending rewards');

        for (const [poolToken, reserveTokens] of Object.entries(providerRewards)) {
            for (const [reserveToken, providers] of Object.entries(reserveTokens)) {
                for (const provider of Object.keys(providers)) {
                    trace(
                        'Getting provider rewards',
                        arg('provider', provider),
                        arg('poolToken', poolToken),
                        arg('reserveToken', reserveToken)
                    );

                    set(
                        pendingRewards,
                        [poolToken, reserveToken, provider],
                        await web3Provider.call(
                            contracts.TestStakingRewards.methods.pendingReserveRewards(
                                provider,
                                poolToken,
                                reserveToken
                            )
                        )
                    );
                }
            }
        }

        info('Finished getting all provider rewards');

        return pendingRewards;
    };

    const getRewards = async (liquidity, fromBlock, toBlock) => {
        info('Getting all rewards from', arg('fromBlock', fromBlock), 'to', arg('toBlock', toBlock));

        const data = await applyPositionChanges(liquidity, fromBlock, toBlock);
        const { poolRewards, providerRewards } = await getRewardsData(data, toBlock);
        const pendingRewards = await getPendingRewards(providerRewards);

        return { poolRewards, providerRewards, pendingRewards, lastBlockNumber: toBlock };
    };

    const { settings, programs, web3Provider, contracts, test, init } = env;

    if (!test || !init) {
        error('Getting all rewards is only possible in test and init modes. Aborting');
    }

    warning('Please be aware that querying a forked mainnet is much slower than querying the mainnet directly');

    const dbDir = path.resolve(__dirname, '../data');
    const liquidityDbPath = path.join(dbDir, 'liquidity.json');
    const rewardsDbPath = path.join(dbDir, 'rewards.json');

    const { liquidity, lastBlockNumber } = JSON.parse(fs.readFileSync(liquidityDbPath));

    let fromBlock = settings.genesisBlock;
    if (resume) {
        ({ lastBlockNumber: fromBlock } = JSON.parse(fs.readFileSync(rewardsDbPath)));
    }

    const toBlock = lastBlockNumber;
    const rewards = await getRewards(liquidity, fromBlock, toBlock);

    fs.writeFileSync(rewardsDbPath, JSON.stringify(rewards, null, 2));
};

module.exports = getRewardsTask;
