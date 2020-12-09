const { accounts, defaultSender, contract, web3 } = require('@openzeppelin/test-environment');
const { expectRevert, expectEvent, constants, BN, time } = require('@openzeppelin/test-helpers');
const { expect } = require('../chai-local');
const humanizeDuration = require('humanize-duration');

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

const MAX_REWARDS = new BN(1000000000).mul(new BN(10).pow(new BN(18)));
const MAX_REWARDS_PER_EPOCH = MAX_REWARDS.div(new BN(10));

const PPM_RESOLUTION = new BN(1000000);
const MULTIPLIER_INCREMENT = PPM_RESOLUTION.div(new BN(4)); // 25%
const REWARDS_DURATION = duration.weeks(12);
const WEEKLY_REWARDS = new BN(200000).mul(new BN(10).pow(new BN(18)));

const expectEqualArrays = (arr1, arr2) => {
    expect(arr1.map((x) => x.toString())).to.be.equalTo(arr2.map((x) => x.toString()));
};

describe('StakingRewardsDistribution', () => {
    let now;
    let networkToken;
    let checkpointStore;
    let networkTokenGovernance;
    let liquidityProtection;
    let store;
    let staking;

    const supervisor = defaultSender;

    const setTime = async (time) => {
        now = time;

        for (const t of [checkpointStore, store, staking]) {
            if (t) {
                await t.setTime(now);
            }
        }
    };

    beforeEach(async () => {
        networkToken = await TestERC20Token.new('TKN', 'TKN');
        await networkToken.issue(supervisor, MAX_REWARDS);

        networkTokenGovernance = await TokenGovernance.new(networkToken.address);
        await networkTokenGovernance.grantRole(ROLE_GOVERNOR, supervisor);
        await networkToken.transferOwnership(networkTokenGovernance.address);
        await networkTokenGovernance.acceptTokenOwnership();

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

        await setTime(new BN(100000000));
    });

    describe('construction', async () => {
        it('should properly initialize roles', async () => {
            expect(await staking.getRoleMemberCount.call(ROLE_SUPERVISOR)).to.be.bignumber.equal(new BN(1));
            expect(await staking.getRoleMemberCount.call(ROLE_REWARDS_DISTRIBUTOR)).to.be.bignumber.equal(new BN(0));

            expect(await staking.getRoleAdmin.call(ROLE_SUPERVISOR)).to.eql(ROLE_SUPERVISOR);
            expect(await staking.getRoleAdmin.call(ROLE_REWARDS_DISTRIBUTOR)).to.eql(ROLE_SUPERVISOR);

            expect(await staking.hasRole.call(ROLE_SUPERVISOR, supervisor)).to.be.true();
            expect(await staking.hasRole.call(ROLE_REWARDS_DISTRIBUTOR, supervisor)).to.be.false();

            expect(await staking.liquidityProtection.call()).to.eql(liquidityProtection.address);
            expect(await staking.maxRewards.call()).to.be.bignumber.equal(MAX_REWARDS);
            expect(await staking.maxRewardsPerEpoch.call()).to.be.bignumber.equal(MAX_REWARDS_PER_EPOCH);
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

    describe('configuration', () => {
        const nonSupervisor = accounts[0];

        it('should revert if a non-supervisor attempts to set the liquidity protection', async () => {
            await expectRevert(
                staking.setLiquidityProtection(liquidityProtection.address, { from: nonSupervisor }),
                'ERR_ACCESS_DENIED'
            );
        });

        it('should revert when setting the liquidity protection to a zero address', async () => {
            await expectRevert(
                staking.setLiquidityProtection(ZERO_ADDRESS, { from: supervisor }),
                'ERR_INVALID_ADDRESS'
            );
        });

        it('should allow setting the liquidity protection', async () => {
            const liquidityProtection2 = accounts[9];
            await staking.setLiquidityProtection(liquidityProtection2, { from: supervisor });
            expect(await staking.liquidityProtection.call()).to.eql(liquidityProtection2);
        });

        it('should revert if a non-supervisor attempts to set the max rewards', async () => {
            await expectRevert(staking.setMaxRewards(MAX_REWARDS, { from: nonSupervisor }), 'ERR_ACCESS_DENIED');
        });

        it('should revert when setting the max rewards to be below max rewards per epoch', async () => {
            await expectRevert(
                staking.setMaxRewards(MAX_REWARDS_PER_EPOCH.sub(new BN(1)), { from: supervisor }),
                'ERR_INVALID_VALUE'
            );
        });

        it('should allow setting the max rewards', async () => {
            const maxRewards = MAX_REWARDS.add(new BN(1000));
            await staking.setMaxRewards(maxRewards, { from: supervisor });
            expect(await staking.maxRewards.call()).to.be.bignumber.equal(maxRewards);
        });

        it('should revert if a non-supervisor attempts to set the max rewards per epoch', async () => {
            await expectRevert(
                staking.setMaxRewardsPerEpoch(MAX_REWARDS_PER_EPOCH, { from: nonSupervisor }),
                'ERR_ACCESS_DENIED'
            );
        });

        it('should revert when setting the max rewards per epoch to be above the max rewards', async () => {
            await expectRevert(
                staking.setMaxRewardsPerEpoch(MAX_REWARDS.add(new BN(1)), { from: supervisor }),
                'ERR_INVALID_VALUE'
            );
        });

        it('should allow setting the max rewards per epoch', async () => {
            const maxRewardsPerEpoch = MAX_REWARDS_PER_EPOCH.add(new BN(1000));
            await staking.setMaxRewardsPerEpoch(maxRewardsPerEpoch, { from: supervisor });
            expect(await staking.maxRewardsPerEpoch.call()).to.be.bignumber.equal(maxRewardsPerEpoch);
        });
    });

    describe('setting rewards', () => {
        const distributor = accounts[1];
        const nonDistributor = accounts[2];
        const poolToken = accounts[3];

        const providers = [accounts[1], accounts[2], accounts[3], accounts[4]];
        const ids = [new BN(123), new BN(2), new BN(3), new BN(10)];
        const startTimes = [new BN(0), new BN(0), new BN(0), new BN(0)];
        beforeEach(async () => {
            await staking.grantRole(ROLE_REWARDS_DISTRIBUTOR, distributor);

            await store.addPoolProgram(poolToken, now, now.add(REWARDS_DURATION), WEEKLY_REWARDS);
            await store.addPositions(poolToken, providers, ids, startTimes);
        });

        const testSetRewards = async (epoch, ids, amounts) => {
            let totalRewards = await staking.totalRewards.call();
            let totalEpochRewards = await staking.totalEpochRewards.call(epoch);

            for (const id of ids) {
                const prevAmount = await staking.pendingPositionEpochRewards.call(id, epoch);
                totalRewards = totalRewards.sub(prevAmount);
                totalEpochRewards = totalEpochRewards.sub(prevAmount);
            }

            const res = await staking.setRewards(epoch, ids, amounts, { from: distributor });

            const rewards = {};
            let epochRewards = new BN(0);
            for (let i = 0; i < ids.length; ++i) {
                const id = ids[i];
                const amount = amounts[i];

                rewards[id] = amount;

                expectEvent(res, 'RewardsUpdated', { epoch, id, amount });
            }

            for (const [id, amount] of Object.entries(rewards)) {
                const pendingPositionEpochs = await staking.pendingPositionEpochs.call(id, false);
                expect(pendingPositionEpochs.map((e) => e.toString())).to.be.containing(epoch.toString());
                expect(await staking.pendingPositionEpochRewards.call(id, epoch)).to.be.bignumber.equal(amount);

                totalRewards = totalRewards.add(amount);
                totalEpochRewards = totalEpochRewards.add(amount);
                epochRewards = epochRewards.add(amount);
            }

            expect(await staking.totalRewards.call()).be.bignumber.equal(totalRewards);
            expect(await staking.totalEpochRewards.call(epoch)).be.bignumber.equal(totalEpochRewards);
        };

        it('should revert when a non-distributor attempts to set rewards', async () => {
            await expectRevert(
                staking.setRewards(new BN(1), [ids[0], ids[1]], [new BN(10), new BN(200)], {
                    from: nonDistributor
                }),
                'ERR_ACCESS_DENIED'
            );
        });

        it('should revert when setting rewards for non-existing positions', async () => {
            await expectRevert(
                staking.setRewards(new BN(1), [ids[0], new BN(50000)], [new BN(10), new BN(200)], {
                    from: distributor
                }),
                'ERR_INVALID_ID'
            );
        });

        it('should revert when a setting more than the max epoch rewards', async () => {
            await expectRevert(
                staking.setRewards(new BN(1), [ids[0], ids[1]], [new BN(10), MAX_REWARDS_PER_EPOCH], {
                    from: distributor
                }),
                'ERR_MAX_REWARDS_PER_EPOCH'
            );

            const reward = new BN(1000);
            await staking.setRewards(new BN(1), [ids[0], ids[1]], [reward, MAX_REWARDS_PER_EPOCH.sub(reward)], {
                from: distributor
            });
            await expectRevert(
                staking.setRewards(new BN(1), [ids[2]], [new BN(1)], { from: distributor }),
                'ERR_MAX_REWARDS_PER_EPOCH'
            );
        });

        it('should revert when a setting more than the global max rewards', async () => {
            await expectRevert(
                staking.setRewards(new BN(1), [ids[0], ids[1]], [new BN(10), MAX_REWARDS], {
                    from: distributor
                }),
                'ERR_MAX_REWARDS_PER_EPOCH'
            );

            let i;
            for (i = new BN(0); i.lt(MAX_REWARDS.div(MAX_REWARDS_PER_EPOCH)); i = i.add(new BN(1))) {
                await staking.setRewards(i, [ids[0]], [MAX_REWARDS_PER_EPOCH], { from: distributor });
            }

            await expectRevert(staking.setRewards(i, [ids[0]], [new BN(1)], { from: distributor }), 'ERR_MAX_REWARDS');
        });

        it('should revert when a setting rewards with invalid lengths', async () => {
            await expectRevert(
                staking.setRewards(new BN(1), [ids[0]], [new BN(10), new BN(10)], { from: distributor }),
                'ERR_INVALID_LENGTH'
            );

            await expectRevert(
                staking.setRewards(new BN(1), [ids[0], ids[1]], [new BN(10)], { from: distributor }),
                'ERR_INVALID_LENGTH'
            );
        });

        it('should allow committing an epoch', async () => {
            const epoch = new BN(123);
            await staking.setRewards(epoch, [ids[0], ids[1]], [new BN(100), new BN(1000)], {
                from: distributor
            });

            expect(await staking.isEpochCommitted.call(epoch)).to.be.false();
            await staking.commitEpoch(epoch, { from: distributor });
            expect(await staking.isEpochCommitted.call(epoch)).to.be.true();

            const epoch2 = new BN(200);
            await staking.setRewards(epoch2, [ids[1]], [new BN(1000)], { from: distributor });

            expect(await staking.isEpochCommitted.call(epoch2)).to.be.false();
            await staking.commitEpoch(epoch2, { from: distributor });
            expect(await staking.isEpochCommitted.call(epoch2)).to.be.true();
        });

        it('should revert when attempting to commit an epoch twice', async () => {
            const epoch = new BN(123);
            await staking.setRewards(epoch, [ids[0], ids[1]], [new BN(100), new BN(1000)], {
                from: distributor
            });

            await staking.commitEpoch(epoch, { from: distributor });
            await expectRevert(staking.commitEpoch(epoch, { from: distributor }), 'ERR_ALREADY_COMMITTED');
        });

        it('should revert a non-distributor attempts to commit an epoch rewards', async () => {
            const epoch = new BN(123);
            await staking.setRewards(epoch, [ids[0], ids[1]], [new BN(100), new BN(1000)], {
                from: distributor
            });

            await expectRevert(staking.commitEpoch(epoch, { from: nonDistributor }), 'ERR_ACCESS_DENIED');
        });

        it('should revert when a setting rewards to already committed epoch', async () => {
            const epoch = new BN(123);
            await staking.setRewards(epoch, [ids[0], ids[1]], [new BN(100), new BN(1000)], {
                from: distributor
            });

            await staking.commitEpoch(epoch, { from: distributor });

            await expectRevert(
                staking.setRewards(epoch, [ids[0], ids[1]], [new BN(100), new BN(1000)], {
                    from: distributor
                }),
                'ERR_ALREADY_COMMITTED'
            );
        });

        it('should allow setting multiple epoch rewards', async () => {
            await testSetRewards(new BN(100), [ids[0], ids[1], ids[2]], [new BN(1000), new BN(2000), new BN(3000)]);

            await testSetRewards(new BN(101), [ids[0], ids[2]], [new BN(10000), new BN(30000)]);

            await testSetRewards(
                new BN(1000),
                [ids[2], ids[0], ids[1], ids[3]],
                [new BN(10000), new BN(30000), new BN(0), new BN(1)]
            );
        });

        it('should overwrite same epoch rewards', async () => {
            const epoch = new BN(100);
            await testSetRewards(epoch, [ids[0], ids[1], ids[2]], [new BN(1000), new BN(2000), new BN(3000)]);

            await testSetRewards(epoch, [ids[0], ids[1], ids[2]], [new BN(100000), new BN(200000), new BN(300000)]);

            await testSetRewards(epoch, [ids[0], ids[1], ids[2]], [new BN(0), new BN(0), new BN(0)]);
        });

        it('should overwrite same provider rewards', async () => {
            const epoch = new BN(100);

            await testSetRewards(
                epoch,
                [ids[0], ids[1], ids[0], ids[1], ids[1]],
                [new BN(1000), new BN(2000), new BN(30000), new BN(4000), new BN(50000)]
            );

            expect(await staking.pendingPositionEpochRewards.call(ids[0], epoch)).to.be.bignumber.equal(new BN(30000));
            expect(await staking.pendingPositionEpochRewards.call(ids[1], epoch)).to.be.bignumber.equal(new BN(50000));

            await testSetRewards(epoch, [ids[2], ids[1], ids[2]], [new BN(1000), new BN(2000), new BN(50000)]);

            expect(await staking.pendingPositionEpochRewards.call(ids[2], epoch)).to.be.bignumber.equal(new BN(50000));
        });
    });

    const getRewardsMultipliers = (stakingDurations) => {
        const multipliers = [];

        for (const stakingDuration of stakingDurations) {
            if (stakingDuration.gte(duration.weeks(0)) && stakingDuration.lt(duration.weeks(1))) {
                // for 0 <= x <= 1 weeks: 100% PPM
                multipliers.push(PPM_RESOLUTION);
            } else if (stakingDuration.gte(duration.weeks(1)) && stakingDuration.lt(duration.weeks(2))) {
                // for 1 <= x <= 2 weeks: 125% PPM
                multipliers.push(PPM_RESOLUTION.add(MULTIPLIER_INCREMENT));
            } else if (stakingDuration.gte(duration.weeks(2)) && stakingDuration.lt(duration.weeks(3))) {
                // for 2 <= x <= 3 weeks: 150% PPM
                multipliers.push(PPM_RESOLUTION.add(MULTIPLIER_INCREMENT.mul(new BN(2))));
            } else if (stakingDuration.gte(duration.weeks(3)) && stakingDuration.lt(duration.weeks(4))) {
                // for 3 <= x < 4 weeks: 175% PPM
                multipliers.push(PPM_RESOLUTION.add(MULTIPLIER_INCREMENT.mul(new BN(3))));
            } else {
                // for x >= 4 weeks: 200% PPM
                multipliers.push(PPM_RESOLUTION.mul(new BN(2)));
            }
        }

        return multipliers;
    };

    describe('rewards multipliers', async () => {
        const provider = accounts[8];
        const poolToken = accounts[9];
        const id = new BN(1234);

        beforeEach(async () => {
            await store.addPoolProgram(poolToken, now, now.add(REWARDS_DURATION), WEEKLY_REWARDS);
        });

        it('should revert when for unregistered positions or providers', async () => {
            await expectRevert(staking.rewardsMultipliers.call([new BN(5000)], { from: provider }), 'ERR_INVALID_ID');
            await expectRevert(staking.rewardsMultipliers.call([id], { from: accounts[1] }), 'ERR_INVALID_ID');
        });

        it('should reset the multiplier if a position was removed or rewards were claimed', async () => {
            await store.addPositions(poolToken, [provider], [id], [now]);

            let timeDiff = duration.weeks(5);
            await setTime(now.add(timeDiff));
            expectEqualArrays(await staking.rewardsMultipliers.call([id]), getRewardsMultipliers([timeDiff]));

            await checkpointStore.addCheckpoint(provider);
            expectEqualArrays(await staking.rewardsMultipliers.call([id]), getRewardsMultipliers([new BN(0)]));

            timeDiff = duration.weeks(1);
            await setTime(now.add(timeDiff));
            expectEqualArrays(await staking.rewardsMultipliers.call([id]), getRewardsMultipliers([timeDiff]));

            await store.updateLastClaimTime(provider);
            expectEqualArrays(await staking.rewardsMultipliers.call([id]), getRewardsMultipliers([new BN(0)]));

            timeDiff = duration.weeks(3);
            await setTime(now.add(timeDiff));
            expectEqualArrays(await staking.rewardsMultipliers.call([id]), getRewardsMultipliers([timeDiff]));
        });

        it('should return rewards multipliers for multiple positions', async () => {
            const providers = [provider, provider, provider];
            const ids = [id, id.add(new BN(1)), id.add(new BN(2))];
            const durations = [new BN(0), duration.weeks(1), duration.weeks(5)];
            const startTimes = durations.map((d) => now.sub(d));

            await store.addPositions(poolToken, providers, ids, startTimes);

            expectEqualArrays(await staking.rewardsMultipliers.call(ids), getRewardsMultipliers(durations));
        });

        [
            duration.hours(1),
            duration.days(1),
            duration.weeks(1).sub(duration.hours(1)),
            duration.weeks(1),
            duration.weeks(2).sub(duration.hours(1)),
            duration.weeks(2),
            duration.weeks(3).sub(duration.hours(1)),
            duration.weeks(3),
            duration.weeks(4).sub(duration.hours(1)),
            duration.weeks(4),
            duration.weeks(5),
            duration.years(2)
        ].forEach((stakingDuration) => {
            context(`after ${humanizeDuration(stakingDuration.mul(new BN(1000)).toString())}`, async () => {
                beforeEach(async () => {
                    await store.addPositions(poolToken, [provider], [id], [now]);

                    await setTime(now.add(stakingDuration));
                });

                const multipliers = getRewardsMultiplier([stakingDuration]);
                it(`should get a x${
                    multipliers[0].toNumber() / PPM_RESOLUTION.toNumber()
                } rewards multiplier`, async () => {
                    expectEqualArrays(await staking.rewardsMultipliers.call([id]), multipliers);
                });
            });
        });
    });

    describe('claiming and staking rewards', async () => {
        const distributor = accounts[1];
        const poolToken = accounts[8];
        const poolToken2 = accounts[9];
        const provider = accounts[1];
        const provider2 = accounts[2];
        const providers = [provider, provider, provider, provider];
        const ids = [new BN(123), new BN(2), new BN(3), new BN(10)];
        const startTimes = [new BN(0), new BN(0), new BN(0), new BN(0)];

        beforeEach(async () => {
            await staking.grantRole(ROLE_REWARDS_DISTRIBUTOR, distributor);

            await store.addPoolProgram(poolToken, now, now.add(REWARDS_DURATION), WEEKLY_REWARDS);
            await store.addPositions(poolToken, providers, ids, startTimes);
        });

        it('should revert when there is no position', async () => {
            await expectRevert(staking.claimRewards([new BN(12345)]), 'ERR_INVALID_ID');
            await expectRevert(staking.stakeRewards([new BN(12345)], poolToken2), 'ERR_INVALID_ID');
        });

        it('should revert when there are no rewards', async () => {
            await expectRevert(staking.claimRewards([ids[0]], { from: provider }), 'ERR_NO_REWARDS');
            await expectRevert(staking.stakeRewards([ids[0]], poolToken2, { from: provider }), 'ERR_NO_REWARDS');
        });

        it("should revert when claiming or staking other provider's rewards", async () => {
            await expectRevert(staking.claimRewards([ids[0]], { from: provider2 }), 'ERR_ACCESS_DENIED');
            await expectRevert(staking.stakeRewards([ids[0]], poolToken2, { from: provider2 }), 'ERR_ACCESS_DENIED');
        });

        context('with pending rewards', async () => {
            const epochs = [
                new BN(1),
                new BN(100),
                new BN(200),
                new BN(1000),
                new BN(1001),
                new BN(10000),
                new BN(10001)
            ];
            const rewards = {
                [epochs[0]]: {
                    [ids[0]]: new BN(1000),
                    [ids[1]]: new BN(2000),
                    [ids[2]]: new BN(3000),
                    [ids[3]]: new BN(30000)
                },
                [epochs[1]]: {
                    [ids[0]]: new BN(100000),
                    [ids[1]]: new BN(200000),
                    [ids[2]]: new BN(300000),
                    [ids[3]]: new BN(888888)
                },
                [epochs[2]]: {
                    [ids[0]]: new BN(100000)
                },
                [epochs[3]]: {
                    [ids[1]]: new BN(500000)
                },
                [epochs[4]]: {
                    [ids[2]]: new BN(700000)
                },
                [epochs[5]]: {
                    [ids[0]]: new BN(1),
                    [ids[1]]: new BN(2),
                    [ids[2]]: new BN(3),
                    [ids[3]]: new BN(4)
                },
                [epochs[6]]: {
                    [ids[0]]: new BN(100),
                    [ids[1]]: new BN(1000),
                    [ids[2]]: new BN(10000),
                    [ids[3]]: new BN(100000)
                }
            };

            const testRewards = async (ids, provider, stake = false) => {
                for (const id of ids) {
                    const pendingPositionEpochs = await staking.pendingPositionEpochs.call(id, true);
                    expect(pendingPositionEpochs.map((e) => e.toString())).to.be.equalTo(
                        Object.keys(rewards).reduce((res, epoch) => {
                            if (rewards[epoch][id]) {
                                res.push(epoch.toString());
                            }

                            return res;
                        }, [])
                    );
                }

                let totalRewards = new BN(0);
                for (const epoch of Object.keys(rewards)) {
                    for (const id of ids) {
                        if (rewards[epoch][id]) {
                            totalRewards = totalRewards.add(rewards[epoch][id]);
                        }
                    }
                }

                expect(await staking.rewards.call(ids)).to.be.bignumber.equal(totalRewards);

                expect(await store.lastClaimTime.call(provider)).to.be.bignumber.equal(new BN(0));
                const prevBalance = await networkToken.balanceOf.call(provider);

                if (!stake) {
                    const amount = await staking.claimRewards.call(ids, { from: provider });
                    expect(amount).to.be.bignumber.equal(totalRewards);

                    const res = await staking.claimRewards(ids, { from: provider });

                    const event = res.logs[0];
                    expect(event.event).to.eql('RewardsClaimed');
                    expectEqualArrays(event.args.ids, ids);
                    expect(event.args.amount).to.be.bignumber.equal(totalRewards);

                    expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(
                        prevBalance.add(totalRewards)
                    );

                    expect(await store.lastClaimTime.call(provider)).to.be.bignumber.equal(now);
                } else {
                    const lpPrevBalance = await networkToken.balanceOf.call(liquidityProtection.address);

                    const data = await staking.stakeRewards.call(ids, poolToken2, { from: provider });
                    expect(data[0]).to.be.bignumber.equal(totalRewards);

                    const res = await staking.stakeRewards(ids, poolToken2, { from: provider });
                    const event = res.logs[0];
                    expect(event.event).to.eql('RewardsStaked');
                    expectEqualArrays(event.args.ids, ids);
                    expect(event.args.poolToken).to.eql(poolToken2);
                    expect(event.args.amount).to.be.bignumber.equal(totalRewards);
                    expect(event.args.newId).to.be.bignumber.equal(data[1]);

                    expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(prevBalance);
                    expect(await store.lastClaimTime.call(provider)).to.be.bignumber.equal(new BN(0));

                    expect(await networkToken.balanceOf.call(liquidityProtection.address)).to.be.bignumber.equal(
                        lpPrevBalance.add(totalRewards)
                    );
                    expect(await liquidityProtection.owner.call()).to.eql(provider);
                    expect(await liquidityProtection.poolToken.call()).to.eql(poolToken2);
                    expect(await liquidityProtection.reserveToken.call()).to.eql(networkToken.address);
                    expect(await liquidityProtection.amount.call()).to.be.bignumber.equal(totalRewards);
                }

                for (const id of ids) {
                    const pendingPositionEpochs2 = await staking.pendingPositionEpochs.call(id, true);
                    expect(pendingPositionEpochs2).to.be.ofSize(0);

                    // make sure that epoch rewards are still preserved for monitoring
                    for (const [epoch, data] of Object.entries(rewards)) {
                        expect(await staking.pendingPositionEpochRewards.call(id, epoch)).to.be.bignumber.equal(
                            data[id] ? data[id] : new BN(0)
                        );
                    }
                }
            };

            beforeEach(async () => {
                for (const [epoch, data] of Object.entries(rewards)) {
                    const ids = Object.keys(data);
                    const amounts = Object.values(data);
                    await staking.setRewards(epoch, ids, amounts, { from: distributor });
                    await staking.commitEpoch(epoch, { from: distributor });
                }
            });

            it('should claim all pending rewards', async () => {
                await testRewards(ids, provider);
            });

            it('should revert when claiming rewards twice', async () => {
                await testRewards(ids, provider);
                await expectRevert(staking.claimRewards(ids, { from: provider }), 'ERR_NO_REWARDS');
            });

            it('should claim and stake all pending rewards', async () => {
                await testRewards(ids, provider, true);
            });

            it('should revert when claiming and staking rewards twice', async () => {
                await testRewards(ids, provider, true);
                await expectRevert(staking.stakeRewards(ids, poolToken2, { from: provider }), 'ERR_NO_REWARDS');
            });

            context('with uncommitted rewards', async () => {
                let totalRewards;
                beforeEach(async () => {
                    totalRewards = await staking.rewards.call(ids);
                    await staking.setRewards(new BN(1111), [ids[0]], [new BN(999999999999)], { from: distributor });
                });

                it('should not claim non-committed rewards', async () => {
                    expect(await staking.rewards.call(ids)).to.be.bignumber.equal(totalRewards);

                    await testRewards(ids, provider);
                });

                it('should not claim and stake non-committed rewards', async () => {
                    expect(await staking.rewards.call(ids)).to.be.bignumber.equal(totalRewards);

                    await testRewards(ids, provider, true);
                });
            });
        });
    });
});
