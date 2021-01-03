const humanizeDuration = require('humanize-duration');
const BN = require('bn.js');

const { info, error, arg } = require('../utils/logger');

const setProgramsTask = async (env) => {
    const { settings, contracts, defaultAccount } = env;

    const setPools = async (pools) => {
        info('Adding pools');

        for (const pool of pools) {
            const { poolToken, startTime, endTime, rewardRate } = pool;

            info(
                'Adding pool program',
                arg('poolToken', poolToken),
                arg('startTime', startTime),
                arg('endTime', endTime),
                arg('duration', humanizeDuration((endTime - startTime) * 1000, { units: ['w'] })),
                arg('rewardRate', rewardRate)
            );

            const gas = await contracts.StakingRewardsStore.methods
                .addPoolProgram(poolToken, startTime, endTime, rewardRate)
                .estimateGas({ from: defaultAccount });
            await contracts.StakingRewardsStore.methods
                .addPoolProgram(poolToken, startTime, endTime, rewardRate)
                .send({ from: defaultAccount, gas });
        }
    };

    const verifyPools = async (pools) => {
        info('Verifying pools');

        for (const pool of pools) {
            const { poolToken, startTime, endTime, rewardRate } = pool;

            info('Verifying pool', arg('poolToken', poolToken));

            const data = await contracts.StakingRewardsStore.methods.poolProgram(poolToken).call();

            if (data[0] != startTime) {
                error("Pool start times don't match", arg('expected', startTime), arg('actual', data[0]));
            }

            if (data[1] != endTime) {
                error("Pool end times don't match", arg('expected', endTime), arg('actual', data[1]));
            }

            if (!new BN(data[2]).eq(new BN(rewardRate))) {
                error("Pool weekly rewards times don't match", arg('expected', rewardRate), arg('actual', data[2]));
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
