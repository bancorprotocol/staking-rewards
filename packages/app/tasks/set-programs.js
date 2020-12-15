const humanizeDuration = require('humanize-duration');

const { info, error, arg } = require('../utils/logger');

const setProgramsTask = async (env) => {
    const { settings, contracts, BN, defaultAccount } = env;

    const setPools = async (pools) => {
        info('Adding pools');

        for (const pool of pools) {
            const { poolToken, startTime, endTime, weeklyRewards } = pool;

            info(
                'Adding pool program',
                arg('poolToken', poolToken),
                arg('startTime', startTime),
                arg('endTime', endTime),
                arg('duration', humanizeDuration((endTime - startTime) * 1000, { units: ['w'] })),
                arg('weeklyRewards', weeklyRewards)
            );

            const gas = await contracts.StakingRewardsDistributionStore.methods
                .addPoolProgram(poolToken, startTime, endTime, weeklyRewards)
                .estimateGas({ from: defaultAccount });
            await contracts.StakingRewardsDistributionStore.methods
                .addPoolProgram(poolToken, startTime, endTime, weeklyRewards)
                .send({ from: defaultAccount, gas });
        }
    };

    const verifyPools = async (pools) => {
        info('Verifying pools');

        for (const pool of pools) {
            const { poolToken, startTime, endTime, weeklyRewards } = pool;

            info('Verifying pool', arg('poolToken', poolToken));

            const data = await contracts.StakingRewardsDistributionStore.methods.poolProgram(poolToken).call();

            if (!new BN(data[0]).eq(new BN(startTime))) {
                error("Pool start times don't match", arg('expected', startTime), arg('actual', data[0]));
            }

            if (!new BN(data[1]).eq(new BN(endTime))) {
                error("Pool end times don't match", arg('expected', endTime), arg('actual', data[1]));
            }

            if (!new BN(data[2]).eq(new BN(weeklyRewards))) {
                error("Pool weekly rewards times don't match", arg('expected', weeklyRewards), arg('actual', data[2]));
            }
        }
    };

    const {
        rewards: { pools }
    } = settings;

    await setPools(pools);
    await verifyPools(pools);
};

module.exports = setProgramsTask;
