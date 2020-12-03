const { accounts, defaultSender, contract, web3 } = require('@openzeppelin/test-environment');
const { expectRevert, expectEvent, constants, BN, time } = require('@openzeppelin/test-helpers');
const { expect } = require('../chai-local');

const { ZERO_ADDRESS } = constants;
const { duration } = time;

const TestERC20Token = contract.fromArtifact('TestERC20Token');
const CheckpointStore = contract.fromArtifact('TestCheckpointStore');
const TokenGovernance = contract.fromArtifact('TestTokenGovernance');
const LiquidityProtection = contract.fromArtifact('TestLiquidityProtection');
const StakingRewardsDistributionStore = contract.fromArtifact('TestStakingRewardsDistributionStore');
const StakingRewardsDistribution = contract.fromArtifact('TestStakingRewardsDistribution');

const ROLE_OWNER = web3.utils.keccak256('ROLE_OWNER');
const ROLE_GOVERNOR = web3.utils.keccak256('ROLE_GOVERNOR');
const ROLE_MINTER = web3.utils.keccak256('ROLE_MINTER');
const ROLE_SUPERVISOR = web3.utils.keccak256('ROLE_SUPERVISOR');
const ROLE_REWARDS_DISTRIBUTOR = web3.utils.keccak256('ROLE_REWARDS_DISTRIBUTOR');

describe('StakingRewardsDistribution', () => {
    let networkToken;
    let checkpointStore;
    let networkTokenGovernance;
    let liquidityProtection;
    let store;
    let staking;

    const supervisor = defaultSender;
    const MAX_REWARDS = new BN(1000000000).mul(new BN(10).pow(new BN(18)));
    const MAX_REWARDS_PER_EPOCH = MAX_REWARDS.div(new BN(10));

    beforeEach(async () => {
        networkToken = await TestERC20Token.new('TKN', 'TKN');
        await networkToken.mint(supervisor, MAX_REWARDS);

        networkTokenGovernance = await TokenGovernance.new(networkToken.address);
        await networkTokenGovernance.grantRole(ROLE_GOVERNOR, supervisor);
        await networkToken.transferOwnership(networkTokenGovernance.address);

        liquidityProtection = await LiquidityProtection.new();
        checkpointStore = await CheckpointStore.new();

        store = await StakingRewardsDistributionStore.new();
        staking = await StakingRewardsDistribution.new(
            store.address,
            networkTokenGovernance.address,
            checkpointStore.address,
            liquidityProtection.address,
            MAX_REWARDS,
            MAX_REWARDS_PER_EPOCH
        );

        await networkTokenGovernance.grantRole(ROLE_MINTER, staking.address);
        await store.grantRole(ROLE_OWNER, staking.address);
    });

    describe('construction', async () => {
        it('should properly initialize roles', async () => {
            expect(await staking.getRoleMemberCount.call(ROLE_SUPERVISOR)).to.be.bignumber.equal(new BN(1));
            expect(await staking.getRoleMemberCount.call(ROLE_REWARDS_DISTRIBUTOR)).to.be.bignumber.equal(new BN(0));

            expect(await staking.getRoleAdmin.call(ROLE_SUPERVISOR)).to.eql(ROLE_SUPERVISOR);
            expect(await staking.getRoleAdmin.call(ROLE_REWARDS_DISTRIBUTOR)).to.eql(ROLE_SUPERVISOR);

            expect(await staking.hasRole.call(ROLE_SUPERVISOR, supervisor)).to.be.true();
            expect(await staking.hasRole.call(ROLE_REWARDS_DISTRIBUTOR, supervisor)).to.be.false();
        });

        it('should revert if initialized with a zero address store', async () => {
            await expectRevert(
                StakingRewardsDistribution.new(
                    ZERO_ADDRESS,
                    networkTokenGovernance.address,
                    checkpointStore.address,
                    liquidityProtection.address,
                    MAX_REWARDS,
                    MAX_REWARDS_PER_EPOCH
                ),
                'ERR_INVALID_ADDRESS'
            );
        });

        it('should revert if initialized with a zero address network governance', async () => {
            await expectRevert(
                StakingRewardsDistribution.new(
                    store.address,
                    ZERO_ADDRESS,
                    checkpointStore.address,
                    liquidityProtection.address,
                    MAX_REWARDS,
                    MAX_REWARDS_PER_EPOCH
                ),
                'ERR_INVALID_ADDRESS'
            );
        });

        it('should revert if initialized with a zero address checkpoint store', async () => {
            await expectRevert(
                StakingRewardsDistribution.new(
                    store.address,
                    networkTokenGovernance.address,
                    ZERO_ADDRESS,
                    liquidityProtection.address,
                    MAX_REWARDS,
                    MAX_REWARDS_PER_EPOCH
                ),
                'ERR_INVALID_ADDRESS'
            );
        });

        it('should revert if initialized with a zero address liquidity protection', async () => {
            await expectRevert(
                StakingRewardsDistribution.new(
                    store.address,
                    networkTokenGovernance.address,
                    checkpointStore.address,
                    ZERO_ADDRESS,
                    MAX_REWARDS,
                    MAX_REWARDS_PER_EPOCH
                ),
                'ERR_INVALID_ADDRESS'
            );
        });

        it('should revert if initialized with invalid max rewards restrictions', async () => {
            await expectRevert(
                StakingRewardsDistribution.new(
                    store.address,
                    networkTokenGovernance.address,
                    checkpointStore.address,
                    liquidityProtection.address,
                    MAX_REWARDS,
                    MAX_REWARDS.add(new BN(1))
                ),
                'ERR_INVALID_VALUE'
            );
        });
    });

    describe.only('setting rewards', async () => {
        const distributor = accounts[1];
        const nonDistributor = accounts[2];

        beforeEach(async () => {
            await staking.grantRole(ROLE_REWARDS_DISTRIBUTOR, distributor);
        });

        const testSetRewards = async (epoch, providers, amounts) => {
            let totalRewards = await staking.totalRewards.call();
            let totalEpochRewards = await staking.totalEpochRewards.call(epoch);

            for (const provider of providers) {
                const prevAmount = await staking.pendingProviderEpochRewards.call(provider, epoch);
                totalRewards = totalRewards.sub(prevAmount);
                totalEpochRewards = totalEpochRewards.sub(prevAmount);
            }

            const res = await staking.setRewards(epoch, providers, amounts, { from: distributor });

            const rewards = {};
            let epochRewards = new BN(0);
            for (let i = 0; i < providers.length; ++i) {
                const provider = providers[i];
                const amount = amounts[i];

                rewards[provider] = amount;

                expectEvent(res, 'RewardsUpdated', { provider, amount });
            }

            for (const [provider, amount] of Object.entries(rewards)) {
                const pendingProviderEpochs = await staking.pendingProviderEpochs.call(provider);
                expect(pendingProviderEpochs.map((e) => e.toString())).to.be.containing(epoch.toString());
                expect(await staking.pendingProviderEpochRewards.call(provider, epoch)).to.be.bignumber.equal(amount);

                totalRewards = totalRewards.add(amount);
                totalEpochRewards = totalEpochRewards.add(amount);
                epochRewards = epochRewards.add(amount);
            }

            expect(await staking.totalRewards.call()).be.bignumber.equal(totalRewards);
            expect(await staking.totalEpochRewards.call(epoch)).be.bignumber.equal(totalEpochRewards);
        };

        it('should revert when a non-distributor attempts to set rewards', async () => {
            await expectRevert(
                staking.setRewards(new BN(1), [accounts[1], accounts[2]], [new BN(10), new BN(200)], {
                    from: nonDistributor
                }),
                'ERR_ACCESS_DENIED'
            );
        });

        it('should revert when a setting more than the max epoch rewards', async () => {
            await expectRevert(
                staking.setRewards(new BN(1), [accounts[1], accounts[2]], [new BN(10), MAX_REWARDS_PER_EPOCH], {
                    from: distributor
                }),
                'ERR_MAX_REWARDS_PER_EPOCH'
            );

            const reward = new BN(1000);
            await staking.setRewards(
                new BN(1),
                [accounts[1], accounts[2]],
                [reward, MAX_REWARDS_PER_EPOCH.sub(reward)],
                { from: distributor }
            );
            await expectRevert(
                staking.setRewards(new BN(1), [accounts[3]], [new BN(1)], { from: distributor }),
                'ERR_MAX_REWARDS_PER_EPOCH'
            );
        });

        it('should revert when a setting more than the global max rewards', async () => {
            await expectRevert(
                staking.setRewards(new BN(1), [accounts[1], accounts[2]], [new BN(10), MAX_REWARDS], {
                    from: distributor
                }),
                'ERR_MAX_REWARDS_PER_EPOCH'
            );

            let i;
            for (i = new BN(0); i.lt(MAX_REWARDS.div(MAX_REWARDS_PER_EPOCH)); i = i.add(new BN(1))) {
                await staking.setRewards(i, [accounts[1]], [MAX_REWARDS_PER_EPOCH], { from: distributor });
            }

            await expectRevert(
                staking.setRewards(i, [accounts[1]], [new BN(1)], { from: distributor }),
                'ERR_MAX_REWARDS'
            );
        });

        it('should revert when a setting rewards for a zero address provider', async () => {
            await expectRevert(
                staking.setRewards(new BN(1), [accounts[1], ZERO_ADDRESS], [new BN(10), new BN(10)], {
                    from: distributor
                }),
                'ERR_INVALID_ADDRESS'
            );
        });

        it('should revert when a setting rewards with invalid lengths', async () => {
            await expectRevert(
                staking.setRewards(new BN(1), [accounts[1]], [new BN(10), new BN(10)], { from: distributor }),
                'ERR_INVALID_LENGTH'
            );

            await expectRevert(
                staking.setRewards(new BN(1), [accounts[1], accounts[2]], [new BN(10)], { from: distributor }),
                'ERR_INVALID_LENGTH'
            );
        });

        it.only('should allow committing an epoch', async () => {
            const epoch = new BN(123);
            await staking.setRewards(epoch, [accounts[1], accounts[2]], [new BN(100), new BN(1000)], {
                from: distributor
            });

            expect(await staking.isEpochCommitted.call(epoch)).to.be.false();
            await staking.commitEpoch(epoch, { from: distributor });
            expect(await staking.isEpochCommitted.call(epoch)).to.be.true();

            const epoch2 = new BN(200);
            await staking.setRewards(epoch2, [accounts[2]], [new BN(1000)], { from: distributor });

            expect(await staking.isEpochCommitted.call(epoch2)).to.be.false();
            await staking.commitEpoch(epoch2, { from: distributor });
            expect(await staking.isEpochCommitted.call(epoch2)).to.be.true();
        });

        it('should revert when attempting to commit an epoch twice', async () => {
            const epoch = new BN(123);
            await staking.setRewards(epoch, [accounts[1], accounts[2]], [new BN(100), new BN(1000)], {
                from: distributor
            });

            await staking.commitEpoch(epoch, { from: distributor });
            await expectRevert(staking.commitEpoch(epoch, { from: distributor }), 'ERR_ALREADY_COMMITTED');
        });

        it('should revert a non-distributor attempts to commit an epoch rewards', async () => {
            const epoch = new BN(123);
            await staking.setRewards(epoch, [accounts[1], accounts[2]], [new BN(100), new BN(1000)], {
                from: distributor
            });

            await expectRevert(staking.commitEpoch(epoch, { from: nonDistributor }), 'ERR_ACCESS_DENIED');
        });

        it('should revert when a setting rewards to already committed epoch', async () => {
            const epoch = new BN(123);
            await staking.setRewards(epoch, [accounts[1], accounts[2]], [new BN(100), new BN(1000)], {
                from: distributor
            });

            await staking.commitEpoch(epoch, { from: distributor });

            await expectRevert(
                staking.setRewards(epoch, [accounts[1], accounts[2]], [new BN(100), new BN(1000)], {
                    from: distributor
                }),
                'ERR_ALREADY_COMMITTED'
            );
        });

        it('should allow setting multiple epoch rewards', async () => {
            await testSetRewards(
                new BN(100),
                [accounts[1], accounts[2], accounts[3]],
                [new BN(1000), new BN(2000), new BN(3000)]
            );

            await testSetRewards(new BN(101), [accounts[1], accounts[3]], [new BN(10000), new BN(30000)]);

            await testSetRewards(
                new BN(1000),
                [accounts[3], accounts[1], accounts[2], accounts[5]],
                [new BN(10000), new BN(30000), new BN(0), new BN(1)]
            );
        });

        it('should overwrite same epoch rewards', async () => {
            const epoch = new BN(100);
            await testSetRewards(
                epoch,
                [accounts[1], accounts[2], accounts[3]],
                [new BN(1000), new BN(2000), new BN(3000)]
            );

            await testSetRewards(
                epoch,
                [accounts[1], accounts[2], accounts[3]],
                [new BN(100000), new BN(200000), new BN(300000)]
            );

            await testSetRewards(epoch, [accounts[1], accounts[2], accounts[3]], [new BN(0), new BN(0), new BN(0)]);
        });

        it('should overwrite same provider rewards', async () => {
            const epoch = new BN(100);

            await testSetRewards(
                epoch,
                [accounts[1], accounts[2], accounts[1], accounts[2], accounts[2]],
                [new BN(1000), new BN(2000), new BN(30000), new BN(4000), new BN(50000)]
            );

            expect(await staking.pendingProviderEpochRewards.call(accounts[1], epoch)).to.be.bignumber.equal(
                new BN(30000)
            );
            expect(await staking.pendingProviderEpochRewards.call(accounts[2], epoch)).to.be.bignumber.equal(
                new BN(50000)
            );

            await testSetRewards(
                epoch,
                [accounts[3], accounts[2], accounts[3]],
                [new BN(1000), new BN(2000), new BN(50000)]
            );

            expect(await staking.pendingProviderEpochRewards.call(accounts[3], epoch)).to.be.bignumber.equal(
                new BN(50000)
            );
        });
    });
});
