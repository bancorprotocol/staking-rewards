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
const ContractRegistry = contract.fromArtifact('TestContractRegistry');
const StakingRewardsDistributionStore = contract.fromArtifact('TestStakingRewardsDistributionStore');
const StakingRewardsDistribution = contract.fromArtifact('TestStakingRewardsDistribution');

const LIQUIDITY_PROTECTION = web3.utils.asciiToHex('LiquidityProtection');

const ROLE_OWNER = web3.utils.keccak256('ROLE_OWNER');
const ROLE_GOVERNOR = web3.utils.keccak256('ROLE_GOVERNOR');
const ROLE_MINTER = web3.utils.keccak256('ROLE_MINTER');
const ROLE_SUPERVISOR = web3.utils.keccak256('ROLE_SUPERVISOR');
const ROLE_REWARDS_DISTRIBUTOR = web3.utils.keccak256('ROLE_REWARDS_DISTRIBUTOR');

const MAX_REWARDS = new BN(1000000000).mul(new BN(10).pow(new BN(18)));
const MAX_REWARDS_PER_UPDATE = MAX_REWARDS.div(new BN(10));

const PPM_RESOLUTION = new BN(1000000);
const MULTIPLIER_INCREMENT = PPM_RESOLUTION.div(new BN(4)); // 25%
const REWARDS_DURATION = duration.weeks(12);
const WEEKLY_REWARDS = new BN(200000).mul(new BN(10).pow(new BN(18)));

const expectEqualArrays = (arr1, arr2) => {
    expect(arr1.map((x) => x.toString())).to.be.equalTo(arr2.map((x) => x.toString()));
};

describe('StakingRewardsDistribution', () => {
    let now;
    let contractRegistry;
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
        contractRegistry = await ContractRegistry.new();

        networkToken = await TestERC20Token.new('TKN', 'TKN');
        await networkToken.issue(supervisor, MAX_REWARDS);

        networkTokenGovernance = await TokenGovernance.new(networkToken.address);
        await networkTokenGovernance.grantRole(ROLE_GOVERNOR, supervisor);
        await networkToken.transferOwnership(networkTokenGovernance.address);
        await networkTokenGovernance.acceptTokenOwnership();

        liquidityProtection = await LiquidityProtection.new();
        await contractRegistry.registerAddress(LIQUIDITY_PROTECTION, liquidityProtection.address);

        checkpointStore = await CheckpointStore.new();

        store = await StakingRewardsDistributionStore.new();
        staking = await StakingRewardsDistribution.new(
            store.address,
            networkTokenGovernance.address,
            checkpointStore.address,
            MAX_REWARDS,
            MAX_REWARDS_PER_UPDATE,
            contractRegistry.address
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

            expect(await staking.maxRewards.call()).to.be.bignumber.equal(MAX_REWARDS);
            expect(await staking.maxRewardsPerUpdate.call()).to.be.bignumber.equal(MAX_REWARDS_PER_UPDATE);
        });

        it('should revert if initialized with a zero address store', async () => {
            await expectRevert(
                StakingRewardsDistribution.new(
                    ZERO_ADDRESS,
                    networkTokenGovernance.address,
                    checkpointStore.address,
                    MAX_REWARDS,
                    MAX_REWARDS_PER_UPDATE,
                    contractRegistry.address
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
                    MAX_REWARDS,
                    MAX_REWARDS_PER_UPDATE,
                    contractRegistry.address
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
                    MAX_REWARDS,
                    MAX_REWARDS_PER_UPDATE,
                    contractRegistry.address
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
                    MAX_REWARDS,
                    MAX_REWARDS.add(new BN(1)),
                    contractRegistry.address
                ),
                'ERR_INVALID_VALUE'
            );
        });

        it('should revert if initialized with a zero address registry', async () => {
            await expectRevert(
                StakingRewardsDistribution.new(
                    store.address,
                    networkTokenGovernance.address,
                    checkpointStore.address,
                    MAX_REWARDS,
                    MAX_REWARDS_PER_UPDATE,
                    ZERO_ADDRESS
                ),
                'ERR_INVALID_ADDRESS'
            );
        });
    });

    describe('configuration', () => {
        const nonSupervisor = accounts[0];

        it('should revert if a non-supervisor attempts to set the max rewards', async () => {
            await expectRevert(staking.setMaxRewards(MAX_REWARDS, { from: nonSupervisor }), 'ERR_ACCESS_DENIED');
        });

        it('should revert when setting the max rewards to be below max rewards per an update', async () => {
            await expectRevert(
                staking.setMaxRewards(MAX_REWARDS_PER_UPDATE.sub(new BN(1)), { from: supervisor }),
                'ERR_INVALID_VALUE'
            );
        });

        it('should allow setting the max rewards', async () => {
            const maxRewards = MAX_REWARDS.add(new BN(1000));
            await staking.setMaxRewards(maxRewards, { from: supervisor });
            expect(await staking.maxRewards.call()).to.be.bignumber.equal(maxRewards);
        });

        it('should revert if a non-supervisor attempts to set the max rewards per an update', async () => {
            await expectRevert(
                staking.setMaxRewardsPerUpdate(MAX_REWARDS_PER_UPDATE, { from: nonSupervisor }),
                'ERR_ACCESS_DENIED'
            );
        });

        it('should revert when setting the max rewards per an update to be above the max rewards', async () => {
            await expectRevert(
                staking.setMaxRewardsPerUpdate(MAX_REWARDS.add(new BN(1)), { from: supervisor }),
                'ERR_INVALID_VALUE'
            );
        });

        it('should allow setting the max rewards per an update', async () => {
            const maxRewardsPerUpdate = MAX_REWARDS_PER_UPDATE.add(new BN(1000));
            await staking.setMaxRewardsPerUpdate(maxRewardsPerUpdate, { from: supervisor });
            expect(await staking.maxRewardsPerUpdate.call()).to.be.bignumber.equal(maxRewardsPerUpdate);
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

        const testSetRewards = async (ids, amounts, prevTotalAmounts) => {
            let totalRewards = await staking.totalRewards.call();
            for (const amount of amounts) {
                totalRewards = totalRewards.add(amount);
            }

            const res = await staking.setRewards(ids, amounts, prevTotalAmounts, { from: distributor });

            const rewards = {};
            for (let i = 0; i < ids.length; ++i) {
                const id = ids[i];
                const amount = amounts[i];

                rewards[id] = amount;

                expectEvent(res, 'RewardsUpdated', { id, amount });
            }

            expect(await staking.totalRewards.call()).be.bignumber.equal(totalRewards);
        };

        it('should revert when a non-distributor attempts to set rewards', async () => {
            await expectRevert(
                staking.setRewards([ids[0], ids[1]], [new BN(10), new BN(200)], [new BN(0), new BN(0)], {
                    from: nonDistributor
                }),
                'ERR_ACCESS_DENIED'
            );
        });

        it('should revert when setting rewards for non-existing positions', async () => {
            await expectRevert(
                staking.setRewards([ids[0], new BN(50000)], [new BN(10), new BN(200)], [new BN(0), new BN(0)], {
                    from: distributor
                }),
                'ERR_INVALID_ID'
            );
        });

        it('should revert when a setting more than the max per update rewards', async () => {
            await expectRevert(
                staking.setRewards([ids[0], ids[1]], [new BN(10), MAX_REWARDS_PER_UPDATE], [new BN(0), new BN(0)], {
                    from: distributor
                }),
                'ERR_MAX_REWARDS_PER_UPDATE'
            );
        });

        it('should revert when a setting more than the global max rewards', async () => {
            await expectRevert(
                staking.setRewards([ids[0], ids[1]], [new BN(10), MAX_REWARDS], [new BN(0), new BN(0)], {
                    from: distributor
                }),
                'ERR_MAX_REWARDS_PER_UPDATE'
            );

            let i;
            let prevAmount = new BN(0);
            for (i = new BN(0); i.lt(MAX_REWARDS.div(MAX_REWARDS_PER_UPDATE)); i = i.add(new BN(1))) {
                await staking.setRewards([ids[0]], [MAX_REWARDS_PER_UPDATE], [i.mul(MAX_REWARDS_PER_UPDATE)], {
                    from: distributor
                });
            }

            await expectRevert(
                staking.setRewards([ids[0]], [new BN(1)], [MAX_REWARDS], { from: distributor }),
                'ERR_MAX_REWARDS'
            );
        });

        it('should revert when a setting rewards with invalid lengths', async () => {
            await expectRevert(
                staking.setRewards([ids[0]], [new BN(10), new BN(10)], [new BN(0), new BN(0)], { from: distributor }),
                'ERR_INVALID_LENGTH'
            );

            await expectRevert(
                staking.setRewards([ids[0], ids[1]], [new BN(10)], [new BN(0), new BN(0)], { from: distributor }),
                'ERR_INVALID_LENGTH'
            );

            await expectRevert(
                staking.setRewards([ids[0], ids[1]], [new BN(10)], [new BN(0), new BN(0)], { from: distributor }),
                'ERR_INVALID_LENGTH'
            );
        });

        it('should revert when a setting rewards with incorrect previous amounts', async () => {
            await expectRevert(
                staking.setRewards([ids[0], ids[1]], [new BN(10), new BN(10)], [new BN(0), new BN(1)], {
                    from: distributor
                }),
                'ERR_INVALID_AMOUNT'
            );

            await staking.setRewards([ids[0], ids[1]], [new BN(10), new BN(10)], [new BN(0), new BN(0)], {
                from: distributor
            });

            await expectRevert(
                staking.setRewards([ids[0], ids[1]], [new BN(200), new BN(100)], [new BN(0), new BN(10)], {
                    from: distributor
                }),
                'ERR_INVALID_AMOUNT'
            );

            await expectRevert(
                staking.setRewards([ids[0], ids[1]], [new BN(200), new BN(100)], [new BN(10), new BN(0)], {
                    from: distributor
                }),
                'ERR_INVALID_AMOUNT'
            );
        });

        it('should allow setting multiple rewards', async () => {
            await testSetRewards(
                [ids[0], ids[1], ids[2]],
                [new BN(1000), new BN(2000), new BN(3000)],
                [new BN(0), new BN(0), new BN(0)]
            );

            await testSetRewards([ids[0], ids[2]], [new BN(10000), new BN(30000)], [new BN(1000), new BN(3000)]);

            await testSetRewards(
                [ids[2], ids[0], ids[1], ids[3]],
                [new BN(10000), new BN(30000), new BN(0), new BN(1)],
                [new BN(33000), new BN(11000), new BN(2000), new BN(0)]
            );
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
            const rewards = [
                {
                    [ids[0]]: new BN(1000),
                    [ids[1]]: new BN(2000),
                    [ids[2]]: new BN(3000),
                    [ids[3]]: new BN(30000)
                },
                {
                    [ids[0]]: new BN(100000),
                    [ids[1]]: new BN(200000),
                    [ids[2]]: new BN(300000),
                    [ids[3]]: new BN(888888)
                },
                {
                    [ids[0]]: new BN(100000)
                },
                {
                    [ids[1]]: new BN(500000)
                },
                {
                    [ids[2]]: new BN(700000)
                },
                {
                    [ids[0]]: new BN(1),
                    [ids[1]]: new BN(2),
                    [ids[2]]: new BN(3),
                    [ids[3]]: new BN(4)
                },
                {
                    [ids[0]]: new BN(100),
                    [ids[1]]: new BN(1000),
                    [ids[2]]: new BN(10000),
                    [ids[3]]: new BN(100000)
                }
            ];

            const testRewards = async (ids, provider, stake = false) => {
                const totalPositionRewards = new BN(0);
                let totalRewards = new BN(0);
                for (const data of rewards) {
                    for (const [id, amount] of Object.entries(data)) {
                        if (amount) {
                            totalRewards = totalRewards.add(amount);
                            if (!totalPositionRewards[id]) {
                                totalPositionRewards[id] = new BN(0);
                            }
                            totalPositionRewards[id] = totalPositionRewards[id].add(amount);
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

                expect(await staking.claimedProviderRewards.call(provider)).to.be.bignumber.equal(totalRewards);

                for (const id of ids) {
                    expect(await staking.claimedPositionRewards.call(id)).to.be.bignumber.equal(
                        totalPositionRewards[id]
                    );
                }

                expect(await staking.rewards.call(ids)).to.be.bignumber.equal(new BN(0));
            };

            beforeEach(async () => {
                for (const data of rewards) {
                    const ids = Object.keys(data);
                    const amounts = Object.values(data);

                    const prevAmounts = [];
                    for (const id of ids) {
                        prevAmounts.push(await staking.rewards.call([id]));
                    }

                    await staking.setRewards(ids, amounts, prevAmounts, { from: distributor });
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

            it('should update total position claimed rewards when claiming', async () => {
                const id = ids[0];

                await staking.claimRewards([id], { from: provider });
                const claimed = await staking.claimedPositionRewards.call(id);

                const reward = new BN(999999999999);
                await staking.setRewards([id], [reward], [new BN(0)], { from: distributor });
                await staking.claimRewards([id], { from: provider });
                expect(await staking.claimedPositionRewards.call(id)).to.be.bignumber.equal(claimed.add(reward));
            });

            it('should update total position claimed rewards when staking', async () => {
                const id = ids[0];

                await staking.stakeRewards([id], poolToken2, { from: provider });
                const claimed = await staking.claimedPositionRewards.call(id);

                const reward = new BN(999999999999);
                await staking.setRewards([id], [reward], [new BN(0)], { from: distributor });
                await staking.stakeRewards([id], poolToken2, { from: provider });
                expect(await staking.claimedPositionRewards.call(id)).to.be.bignumber.equal(claimed.add(reward));
            });

            it('should update total provider claimed rewards when claiming', async () => {
                const id = ids[0];

                await staking.claimRewards([id], { from: provider });
                const claimed = await staking.claimedProviderRewards.call(provider);

                const reward = new BN(999999999999);
                await staking.setRewards([id], [reward], [new BN(0)], { from: distributor });
                await staking.claimRewards([id], { from: provider });
                expect(await staking.claimedProviderRewards.call(provider)).to.be.bignumber.equal(claimed.add(reward));
            });
        });
    });
});
