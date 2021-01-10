const fs = require('fs');
const path = require('path');
const BN = require('bn.js');

const { trace, info, error, arg } = require('../utils/logger');

const BATCH_SIZE = 50;

const setRewardsTask = async (env) => {
    const setPoolRewards = async (poolRewards) => {
        info('Setting pool rewards');

        let filtered = 0;

        const poolTokens = [];
        const poolReserveTokens = [];
        const lastUpdateTimes = [];
        const rewardsPerToken = [];
        const totalClaimedPoolRewards = [];

        for (const [poolToken, reserveTokens] of Object.entries(poolRewards)) {
            for (const [reserveToken, data] of Object.entries(reserveTokens)) {
                const { lastUpdateTime, rewardPerToken, totalClaimedRewards } = data;

                const poolData = await web3Provider.call(
                    contracts.StakingRewardsStore.methods.poolRewards(poolToken, reserveToken)
                );

                if (
                    new BN(poolData[0]).eq(new BN(lastUpdateTime)) &&
                    new BN(poolData[1]).eq(new BN(rewardPerToken)) &&
                    new BN(poolData[2]).eq(new BN(totalClaimedReward))
                ) {
                    trace(
                        'Skipping already up to date pool rewards',
                        arg('poolToken', poolToken),
                        arg('reserveToken', reserveToken)
                    );

                    filtered++;

                    continue;
                }

                trace(
                    'Setting pool rewards for',
                    arg('poolToken', poolToken),
                    arg('reserveToken', reserveToken),
                    arg('lastUpdateTime', lastUpdateTime),
                    arg('rewardPerToken', rewardPerToken),
                    arg('totalClaimedRewards', totalClaimedRewards)
                );

                poolTokens.push(poolToken);
                poolReserveTokens.push(reserveToken);
                lastUpdateTimes.push(lastUpdateTime);
                rewardsPerToken.push(rewardPerToken);
                totalClaimedPoolRewards.push(totalClaimedRewards);
            }
        }

        const tx = await web3Provider.send(
            contracts.StakingRewardsStore.methods.setPoolsRewardData(
                poolTokens,
                poolReserveTokens,
                lastUpdateTimes,
                rewardsPerToken,
                totalClaimedPoolRewards
            )
        );

        info('Finished setting all pool rewards', arg('filtered', filtered), arg('totalGas', tx.gasUsed));
    };

    const verifyPoolRewards = async (poolRewards) => {
        info('Verifying pool rewards');

        for (const [poolToken, reserveTokens] of Object.entries(poolRewards)) {
            for (const [reserveToken, data] of Object.entries(reserveTokens)) {
                const { lastUpdateTime, rewardPerToken, totalClaimedReward } = data;

                trace('Verifying pool rewards', arg('poolToken', poolToken), arg('reserveToken', reserveToken));

                const poolData = await web3Provider.call(
                    contracts.StakingRewardsStore.methods.poolRewards(poolToken, reserveToken)
                );

                const actualLastUpdateTime = new BN(poolData[0]);
                const actualRewardPerToken = new BN(poolData[1]);
                const actualTotalClaimedReward = new BN(poolData[2]);

                if (!actualLastUpdateTime.eq(new BN(lastUpdateTime))) {
                    error(
                        "Pool last update times don't match",
                        arg('expected', lastUpdateTime),
                        arg('actual', actualLastUpdateTime)
                    );
                }

                if (!actualRewardPerToken.eq(new BN(rewardPerToken))) {
                    error(
                        "Pool rewards per-token times don't match",
                        arg('expected', rewardPerToken),
                        arg('actual', actualRewardPerToken)
                    );
                }

                if (!actualTotalClaimedReward.eq(new BN(totalClaimedReward))) {
                    error(
                        "Pool total claimed rewards  don't match",
                        arg('expected', totalClaimedReward),
                        arg('actual', actualTotalClaimedReward)
                    );
                }
            }
        }

        info('Finished verifying pool rewards');
    };

    const setProviderRewards = async (providerRewards) => {
        info('Setting provider rewards in batches of', arg('batchSize', BATCH_SIZE), '(per-pool)');

        let filtered = 0;

        const transactions = [];

        for (const [poolToken, reserveTokens] of Object.entries(providerRewards)) {
            for (const [reserveToken, providers] of Object.entries(reserveTokens)) {
                const entries = Object.entries(providers);

                const newProviderRewards = [];
                for (const [provider, data] of entries) {
                    const {
                        rewardPerToken,
                        pendingBaseRewards,
                        totalClaimedRewards,
                        effectiveStakingTime,
                        baseRewardsDebt,
                        baseRewardsDebtMultiplier
                    } = data;

                    const providerData = await web3Provider.call(
                        contracts.StakingRewardsStore.methods.providerRewards(poolToken, reserveToken, provider)
                    );

                    const poolRewardPerToken = new BN(providerData[0]);
                    const poolPendingBaseRewards = new BN(providerData[1]);
                    const poolTotalClaimedRewards = new BN(providerData[2]);
                    const poolEffectiveStakingTime = new BN(providerData[3]);
                    const poolBaseRewardsDebt = new BN(providerData[4]);
                    const poolBaseRewardsDebtMultiplier = new BN(providerData[5]);

                    if (
                        poolRewardPerToken.eq(new BN(rewardPerToken)) &&
                        poolPendingBaseRewards.eq(new BN(pendingBaseRewards)) &&
                        poolTotalClaimedRewards.eq(new BN(totalClaimedRewards)) &&
                        poolEffectiveStakingTime.eq(new BN(effectiveStakingTime)) &&
                        poolBaseRewardsDebt.eq(new BN(baseRewardsDebt)) &&
                        poolBaseRewardsDebtMultiplier.eq(new BN(baseRewardsDebtMultiplier))
                    ) {
                        trace(
                            'Skipping already up to date provider rewards',
                            arg('poolToken', poolToken),
                            arg('reserveToken', reserveToken),
                            arg('provider', provider)
                        );

                        filtered++;

                        continue;
                    }

                    trace(
                        'Setting provider rewards for',
                        arg('poolToken', poolToken),
                        arg('reserveToken', reserveToken),
                        arg('provider', provider)
                    );

                    newProviderRewards.push({
                        provider,
                        rewardPerToken,
                        pendingBaseRewards,
                        totalClaimedRewards,
                        effectiveStakingTime,
                        baseRewardsDebt,
                        baseRewardsDebtMultiplier
                    });
                }

                for (let i = 0; i < newProviderRewards.length; i += BATCH_SIZE) {
                    const batch = newProviderRewards.slice(i, i + BATCH_SIZE);

                    const providersBatch = batch.map((e) => e.provider);
                    const rewardPerTokenBatch = batch.map((e) => e.rewardPerToken);
                    const pendingBaseRewardsBatch = batch.map((e) => e.pendingBaseRewards);
                    const totalClaimedRewardsBatch = batch.map((e) => e.totalClaimedRewards);
                    const effectiveStakingTimeBatch = batch.map((e) => e.effectiveStakingTime);
                    const baseRewardsDebtBatch = batch.map((e) => e.baseRewardsDebt);
                    const baseRewardsDebtMultiplierBatch = batch.map((e) => e.baseRewardsDebtMultiplier);

                    for (let j = 0; j < providersBatch.length; ++j) {
                        const provider = providersBatch[j];
                        const rewardPerToken = rewardPerTokenBatch[j];
                        const pendingBaseRewards = pendingBaseRewardsBatch[j];
                        const totalClaimedRewards = totalClaimedRewardsBatch[j];
                        const effectiveStakingTime = effectiveStakingTimeBatch[j];
                        const baseRewardsDebt = baseRewardsDebtBatch[j];
                        const baseRewardsDebtMultiplier = baseRewardsDebtMultiplierBatch[j];

                        trace(
                            'Setting provider rewards for',
                            arg('provider', provider),
                            arg('poolToken', poolToken),
                            arg('reserveToken', reserveToken),
                            arg('rewardPerToken', rewardPerToken),
                            arg('pendingBaseRewards', pendingBaseRewards),
                            arg('totalClaimedRewards', totalClaimedRewards),
                            arg('effectiveStakingTime', effectiveStakingTime),
                            arg('baseRewardsDebt', baseRewardsDebt),
                            arg('baseRewardsDebtMultiplier', baseRewardsDebtMultiplier)
                        );
                    }

                    transactions.push(
                        web3Provider.send(
                            contracts.StakingRewardsStore.methods.setProviderRewardData(
                                poolToken,
                                reserveToken,
                                providersBatch,
                                rewardPerTokenBatch,
                                pendingBaseRewardsBatch,
                                totalClaimedRewardsBatch,
                                effectiveStakingTimeBatch,
                                baseRewardsDebtBatch,
                                baseRewardsDebtMultiplierBatch
                            )
                        )
                    );
                }
            }
        }

        return Promise.all(transactions).then((receipts) => {
            const totalGas = receipts.reduce((res, receipt) => (res += receipt.gasUsed), 0);

            info('Finished setting all provider rewards', arg('filtered', filtered), arg('totalGas', totalGas));
        });
    };

    const verifyProviderRewards = async (providerRewards) => {
        info('Verifying provider rewards');

        for (const [poolToken, reserveTokens] of Object.entries(providerRewards)) {
            for (const [reserveToken, providers] of Object.entries(reserveTokens)) {
                for (const [provider, data] of Object.entries(providers)) {
                    trace(
                        'Verifying provider rewards',
                        arg('provider', provider),
                        arg('poolToken', poolToken),
                        arg('reserveToken', reserveToken)
                    );

                    const {
                        rewardPerToken,
                        pendingBaseRewards,
                        totalClaimedRewards,
                        effectiveStakingTime,
                        baseRewardsDebt,
                        baseRewardsDebtMultiplier
                    } = data;

                    const providerData = await web3Provider.call(
                        contracts.StakingRewardsStore.methods.providerRewards(poolToken, reserveToken, provider)
                    );

                    const actualRewardPerToken = new BN(providerData[0]);
                    const actualPendingBaseRewards = new BN(providerData[1]);
                    const actualTotalClaimedRewards = new BN(providerData[2]);
                    const actualEffectiveStakingTime = new BN(providerData[3]);
                    const actualBaseRewardsDebt = new BN(providerData[4]);
                    const actualBaseRewardsDebtMultiplier = new BN(providerData[5]);

                    if (!actualRewardPerToken.eq(new BN(rewardPerToken))) {
                        error(
                            "Provider reward rates per-token don't match",
                            arg('expected', rewardPerToken),
                            arg('actual', actualRewardPerToken)
                        );
                    }

                    if (!actualPendingBaseRewards.eq(new BN(pendingBaseRewards))) {
                        error(
                            "Provider pending rewards don't match",
                            arg('expected', pendingBaseRewards),
                            arg('actual', actualPendingBaseRewards)
                        );
                    }

                    if (!actualTotalClaimedRewards.eq(new BN(totalClaimedRewards))) {
                        error(
                            "Provider total claimed rewards don't match",
                            arg('expected', totalClaimedRewards),
                            arg('actual', actualTotalClaimedRewards)
                        );
                    }

                    if (!actualEffectiveStakingTime.eq(new BN(effectiveStakingTime))) {
                        error(
                            "Provider effective staking times don't match",
                            arg('expected', effectiveStakingTime),
                            arg('actual', actualEffectiveStakingTime)
                        );
                    }

                    if (!actualBaseRewardsDebt.eq(new BN(baseRewardsDebt))) {
                        error(
                            "Provider base reward debts don't match",
                            arg('expected', baseRewardsDebt),
                            arg('actual', actualBaseRewardsDebt)
                        );
                    }

                    if (!actualBaseRewardsDebtMultiplier.eq(new BN(baseRewardsDebtMultiplier))) {
                        error(
                            "Provider base reward debt multipliers don't match",
                            arg('expected', baseRewardsDebtMultiplier),
                            arg('actual', actualBaseRewardsDebtMultiplier)
                        );
                    }
                }
            }
        }

        info('Finished verifying provider rewards');
    };

    const setRewards = async (data) => {
        const { poolRewards, providerRewards } = data;

        await setPoolRewards(poolRewards);
        await verifyPoolRewards(poolRewards);

        await setProviderRewards(providerRewards);
        await verifyProviderRewards(providerRewards);
    };

    const { web3Provider, contracts } = env;

    const dbDir = path.resolve(__dirname, '../data');
    const dbPath = path.join(dbDir, 'rewards.json');
    if (!fs.existsSync(dbPath)) {
        error('Unable to locate', arg('db', dbPath));
    }

    const data = JSON.parse(fs.readFileSync(dbPath));
    await setRewards(data);
};

module.exports = setRewardsTask;
