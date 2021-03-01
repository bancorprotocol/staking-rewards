const { trace, info, error, arg } = require('../utils/logger');
const DB = require('../utils/db');

const BATCH_SIZE = 25;

const storePoolRewardsTask = async (env, { poolToken }) => {
    const storePoolRewards = async (data) => {
        info('Storing pool rewards for', arg('poolToken', poolToken), arg('batchSize', BATCH_SIZE));

        let totalGas = 0;

        const providers = Object.keys(data.pendingRewards);
        for (let i = 0; i < providers.length; i += BATCH_SIZE) {
            const providersBatch = providers.slice(i, i + BATCH_SIZE);

            for (let j = 0; j < providersBatch.length; ++j) {
                const provider = providersBatch[j];

                trace('Storing provider pool rewards for', arg('provider', provider), arg('poolToken', poolToken));
            }

            const tx = await web3Provider.send(
                contracts.StakingRewards.methods.storePoolRewards(providersBatch, poolToken)
            );

            totalGas += tx.gasUsed;
        }

        info('Finished storing pool rewards', arg('totalGas', totalGas), arg('providers', providers.length));
    };

    const { web3Provider, contracts } = env;

    if (!poolToken) {
        error('Invalid pool token address');
    }

    const db = new DB(`${poolToken}-pending-rewards`);

    await storePoolRewards(db.data);
};

module.exports = storePoolRewardsTask;
