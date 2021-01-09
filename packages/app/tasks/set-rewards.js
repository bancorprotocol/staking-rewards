const fs = require('fs');
const path = require('path');
const BN = require('bn.js');

const { trace, info, error, arg } = require('../utils/logger');

const BATCH_SIZE = 200;

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
                    info(
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

                info('Verifying pool rewards', arg('poolToken', poolToken), arg('reserveToken', reserveToken));

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

    const setRewards = async (data) => {
        const { poolRewards, providerRewards } = data;

        await setPoolRewards(poolRewards);
        await verifyPoolRewards(poolRewards);
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
