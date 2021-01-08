const humanizeDuration = require('humanize-duration');
const BN = require('bn.js');

const { info, error, arg } = require('../utils/logger');

const BATCH_SIZE = 200;

const setProgramsTask = async (env) => {
    const setPrograms = async (programs) => {
        info('Adding programs');

        let totalGas = 0;

        for (let i = 0; i < programs.length; i += BATCH_SIZE) {
            const programsBatch = programs.slice(i, i + BATCH_SIZE);

            const poolTokens = [];
            const reserveTokens = [];
            const rewardShares = [];
            const startTimes = [];
            const endTimes = [];
            const rewardRates = [];

            for (const program of programsBatch) {
                const {
                    poolToken,
                    networkToken,
                    reserveToken,
                    startTime,
                    endTime,
                    networkTokenRate,
                    reserveTokenRate,
                    rewardRate
                } = program;

                const participating = await web3Provider.call(
                    contracts.StakingRewardsStore.methods.isPoolParticipating(poolToken)
                );

                if (participating) {
                    info('Skipping already participating program', arg('poolToken', poolToken));

                    continue;
                }

                info(
                    'Adding program',
                    arg('poolToken', poolToken),
                    arg('networkToken', networkToken),
                    arg('reserveToken', reserveToken),
                    arg('startTime', startTime),
                    arg('endTime', endTime),
                    arg('duration', humanizeDuration((endTime - startTime) * 1000, { units: ['w'] })),
                    arg('networkTokenRate', networkTokenRate),
                    arg('reserveTokenRate', reserveTokenRate),
                    arg('rewardRate', rewardRate)
                );

                poolTokens.push(poolToken);
                reserveTokens.push([networkToken, reserveToken]);
                rewardShares.push([networkTokenRate, reserveTokenRate]);
                startTimes.push(startTime);
                endTimes.push(endTime);
                rewardRates.push(rewardRate);
            }

            if (poolTokens.length === 0) {
                continue;
            }

            const tx = await web3Provider.send(
                contracts.StakingRewardsStore.methods.addPastPoolPrograms(
                    poolTokens,
                    reserveTokens,
                    rewardShares,
                    startTimes,
                    endTimes,
                    rewardRates
                )
            );
            totalGas += tx.gasUsed;
        }

        info('Finished adding new pools times', arg('totalGas', totalGas));
    };

    const verityPrograms = async (programs) => {
        info('Verifying pools');

        for (const program of programs) {
            const {
                poolToken,
                networkToken,
                reserveToken,
                startTime,
                endTime,
                networkTokenRate,
                reserveTokenRate,
                rewardRate
            } = program;

            info('Verifying program', arg('poolToken', poolToken));

            const data = await web3Provider.call(contracts.StakingRewardsStore.methods.poolProgram(poolToken));

            const actualStartTime = data[0];
            const actualEndTime = data[1];
            const actualRewardRate = data[2];
            const [actualNetworkToken, actualReserveToken] = data[3];
            const [actualNetworkTokenRate, actualReserveTokenRate] = data[4];

            if (actualStartTime != startTime) {
                error("Program start times don't match", arg('expected', startTime), arg('actual', actualStartTime));
            }

            if (actualEndTime != endTime) {
                error("Program end times don't match", arg('expected', endTime), arg('actual', actualEndTime));
            }

            if (!new BN(actualRewardRate).eq(new BN(rewardRate))) {
                error("Program reward rates don't match", arg('expected', rewardRate), arg('actual', actualRewardRate));
            }

            if (actualNetworkToken.toLowerCase() != networkToken.toLowerCase()) {
                error(
                    "Program first reserve tokens don't match",
                    arg('expected', networkToken.toLowerCase()),
                    arg('actual', actualNetworkToken.toLowerCase())
                );
            }

            if (actualReserveToken.toLowerCase() != reserveToken.toLowerCase()) {
                error(
                    "Program second reserve tokens don't match",
                    arg('expected', reserveToken.toLowerCase()),
                    arg('actual', actualReserveToken.toLowerCase())
                );
            }

            if (!new BN(actualNetworkTokenRate).eq(new BN(networkTokenRate))) {
                error(
                    "Program first token rates don't match",
                    arg('expected', networkTokenRate),
                    arg('actual', actualNetworkTokenRate)
                );
            }

            if (!new BN(actualReserveTokenRate).eq(new BN(reserveTokenRate))) {
                error(
                    "Program second token rates don't match",
                    arg('expected', reserveTokenRate),
                    arg('actual', actualReserveTokenRate)
                );
            }
        }
    };

    const { programs, web3Provider, contracts } = env;

    await setPrograms(programs);
    await verityPrograms(programs);
};

module.exports = setProgramsTask;
