const { trace, info, error, arg } = require('../utils/logger');
const DB = require('../utils/db');

const BATCH_SIZE = 1;

const updatePoolRewardsTask = async (env, { poolToken }) => {
    const updatePoolRewards = async (data) => {
        info('Updating pool rewards for', arg('poolToken', poolToken), arg('batchSize', BATCH_SIZE));

        let totalGas = 0;

        const providers = Object.keys(data.pendingRewards);

        for (let i = 0; i < providers.length; i += BATCH_SIZE) {
            const providersBatch = providers.slice(i, i + BATCH_SIZE);

            for (let j = 0; j < providersBatch.length; ++j) {
                const provider = providersBatch[j];

                trace('Updating provider pool rewards for', arg('provider', provider), arg('poolToken', poolToken));
            }

            console.log('START');
            const tx = await web3Provider.send(
                contracts.StakingRewards.methods.updatePoolRewards(providersBatch, poolToken)
            );
            console.log('tx.gasUsed', tx.gasUsed);
            totalGas += tx.gasUsed;
            console.log('END');
        }

        info('Finished updating pool rewards', arg('totalGas', totalGas));
    };

    const { web3Provider, contracts } = env;

    if (!poolToken) {
        error('Invalid pool token address');
    }

    const db = new DB(`${poolToken}-pending-rewards`);

    await updatePoolRewards(db.data);
};

module.exports = updatePoolRewardsTask;
