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
        });

        it('should revert if initialized with a zero address store', async () => {
            await expectRevert(
                StakingRewardsDistribution.new(
                    ZERO_ADDRESS,
                    networkTokenGovernance.address,
                    checkpointStore.address,
                    MAX_REWARDS,
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
                    contractRegistry.address
                ),
                'ERR_INVALID_ADDRESS'
            );
        });

        it('should revert if initialized with a zero address registry', async () => {
            await expectRevert(
                StakingRewardsDistribution.new(
                    store.address,
                    networkTokenGovernance.address,
                    checkpointStore.address,
                    MAX_REWARDS,
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

        it('should allow setting the max rewards', async () => {
            const maxRewards = MAX_REWARDS.add(new BN(1000));
            await staking.setMaxRewards(maxRewards, { from: supervisor });
            expect(await staking.maxRewards.call()).to.be.bignumber.equal(maxRewards);
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

        const testSetRewards = async (ids, amounts) => {
            let totalRewards = await staking.totalRewards.call();

            for (let i = 0; i < ids.length; ++i) {
                const id = ids[i];
                const amount = amounts[i];

                const prevReward = await staking.rewards.call([id]);
                totalRewards = totalRewards.add(amount).sub(prevReward);
            }

            const res = await staking.setRewards(ids, amounts, { from: distributor });

            for (let i = 0; i < ids.length; ++i) {
                const id = ids[i];
                const amount = amounts[i];

                expectEvent(res, 'RewardsUpdated', { id, amount });

                expect(await staking.rewards.call([id])).to.be.bignumber.equal(amount);
            }

            expect(await staking.totalRewards.call()).be.bignumber.equal(totalRewards);
        };

        it('should revert when a non-distributor attempts to set rewards', async () => {
            await expectRevert(
                staking.setRewards([ids[0], ids[1]], [new BN(10), new BN(200)], {
                    from: nonDistributor
                }),
                'ERR_ACCESS_DENIED'
            );
        });

        it('should revert when setting rewards for non-existing positions', async () => {
            await expectRevert(
                staking.setRewards([ids[0], new BN(50000)], [new BN(10), new BN(200)], {
                    from: distributor
                }),
                'ERR_INVALID_ID'
            );
        });

        it('should revert when a setting more than the global max rewards', async () => {
            await expectRevert(
                staking.setRewards([ids[0], ids[1]], [new BN(10), MAX_REWARDS], {
                    from: distributor
                }),
                'ERR_MAX_REWARDS'
            );

            await staking.setRewards([ids[0]], [MAX_REWARDS], { from: distributor });
            await expectRevert(staking.setRewards([ids[1]], [new BN(1)], { from: distributor }), 'ERR_MAX_REWARDS');
        });

        it('should revert when a setting rewards with invalid lengths', async () => {
            await expectRevert(
                staking.setRewards([ids[0]], [new BN(10), new BN(10)], { from: distributor }),
                'ERR_INVALID_LENGTH'
            );

            await expectRevert(
                staking.setRewards([ids[0], ids[1]], [new BN(10)], { from: distributor }),
                'ERR_INVALID_LENGTH'
            );
        });

        it('should allow setting multiple rewards', async () => {
            await testSetRewards([ids[0], ids[1], ids[2]], [new BN(1000), new BN(2000), new BN(3000)]);
            await testSetRewards([ids[0], ids[2]], [new BN(10000), new BN(30000)]);
            await testSetRewards(
                [ids[2], ids[0], ids[1], ids[3]],
                [new BN(10000), new BN(30000), new BN(0), new BN(1)]
            );
        });

        it('should allow setting rewards for the same position twice', async () => {
            await staking.setRewards([ids[0], ids[1], ids[0]], [new BN(10000), new BN(20000), new BN(0)], {
                from: distributor
            });
            expect(await staking.rewards.call([ids[0]])).to.be.bignumber.equal(new BN(0));
            expect(await staking.rewards.call([ids[1]])).to.be.bignumber.equal(new BN(20000));

            await staking.setRewards([ids[1], ids[1], ids[0]], [new BN(10000), new BN(30000), new BN(111)], {
                from: distributor
            });
            expect(await staking.rewards.call([ids[0]])).to.be.bignumber.equal(new BN(111));
            expect(await staking.rewards.call([ids[1]])).to.be.bignumber.equal(new BN(30000));
        });
    });

    describe('updating claimed rewards', () => {
        const distributor = accounts[1];
        const nonDistributor = accounts[2];
        const poolToken = accounts[3];

        const providers = [accounts[1], accounts[2], accounts[3], accounts[4]];
        const ids = [new BN(123), new BN(2), new BN(3), new BN(10)];
        const providersByIds = {
            [ids[0]]: providers[0],
            [ids[1]]: providers[1],
            [ids[2]]: providers[2],
            [ids[3]]: providers[3]
        };
        const startTimes = [new BN(0), new BN(0), new BN(0), new BN(0)];
        beforeEach(async () => {
            await staking.grantRole(ROLE_REWARDS_DISTRIBUTOR, distributor);

            await store.addPoolProgram(poolToken, now, now.add(REWARDS_DURATION), WEEKLY_REWARDS);
            await store.addPositions(poolToken, providers, ids, startTimes);
        });

        const testUpdateClaimRewards = async (ids, amounts) => {
            const prevClaimedRewards = await staking.claimedPositionRewards.call(ids);
            const prevProviderRewards = {};
            for (let i = 0; i < ids.length; ++i) {
                const id = ids[i];
                const provider = providersByIds[id];

                prevProviderRewards[provider] = await staking.claimedProviderRewards.call(provider);
            }

            const res = await staking.updateClaimedRewards(ids, amounts, { from: distributor });

            for (let i = 0; i < ids.length; ++i) {
                const id = ids[i];
                const amount = amounts[i];
                const provider = providersByIds[id];

                expectEvent(res, 'ClaimedRewardsUpdated', { id, amount });

                expect(await staking.claimedProviderRewards.call(provider)).to.be.bignumber.equal(
                    prevProviderRewards[provider].add(amount).sub(prevClaimedRewards[i])
                );
            }

            expectEqualArrays(await staking.claimedPositionRewards.call(ids), amounts);
        };

        it('should revert when a non-distributor attempts to update claimed rewards', async () => {
            await expectRevert(
                staking.updateClaimedRewards([ids[0], ids[1]], [new BN(10), new BN(200)], {
                    from: nonDistributor
                }),
                'ERR_ACCESS_DENIED'
            );
        });

        it('should revert when updating claimed rewards for non-existing positions', async () => {
            await expectRevert(
                staking.updateClaimedRewards([ids[0], new BN(50000)], [new BN(10), new BN(200)], {
                    from: distributor
                }),
                'ERR_INVALID_ID'
            );
        });

        it('should revert when a updating claimed rewards with invalid lengths', async () => {
            await expectRevert(
                staking.updateClaimedRewards([ids[0]], [new BN(10), new BN(10)], { from: distributor }),
                'ERR_INVALID_LENGTH'
            );

            await expectRevert(
                staking.updateClaimedRewards([ids[0], ids[1]], [new BN(10)], { from: distributor }),
                'ERR_INVALID_LENGTH'
            );
        });

        it('should allow update multiple claimed rewards', async () => {
            await testUpdateClaimRewards([ids[0], ids[1], ids[2]], [new BN(1000), new BN(2000), new BN(3000)]);
            await testUpdateClaimRewards([ids[0], ids[2]], [new BN(10000), new BN(30000)]);
            await testUpdateClaimRewards(
                [ids[2], ids[0], ids[1], ids[3]],
                [new BN(10000), new BN(30000), new BN(0), new BN(1)]
            );
        });

        it('should allow updated claimed rewards for the same position twice', async () => {
            await staking.updateClaimedRewards([ids[0], ids[1], ids[0]], [new BN(10000), new BN(20000), new BN(0)], {
                from: distributor
            });
            expect((await staking.claimedPositionRewards.call([ids[0]]))[0]).to.be.bignumber.equal(new BN(0));
            expect((await staking.claimedPositionRewards.call([ids[1]]))[0]).to.be.bignumber.equal(new BN(20000));

            await staking.updateClaimedRewards([ids[1], ids[1], ids[0]], [new BN(10000), new BN(30000), new BN(111)], {
                from: distributor
            });
            expect((await staking.claimedPositionRewards.call([ids[0]]))[0]).to.be.bignumber.equal(new BN(111));
            expect((await staking.claimedPositionRewards.call([ids[1]]))[0]).to.be.bignumber.equal(new BN(30000));
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
            const rewards = {
                [ids[0]]: new BN(100000),
                [ids[1]]: new BN(200000),
                [ids[2]]: new BN(300000),
                [ids[3]]: new BN(888888)
            };

            const testRewards = async (ids, provider, stake = false) => {
                const totalRewards = ids.reduce((res, id) => res.add(rewards[id]), new BN(0));

                expect(await staking.rewards.call(ids)).to.be.bignumber.equal(totalRewards);

                expect(await store.lastClaimTime.call(provider)).to.be.bignumber.equal(new BN(0));
                const prevBalance = await networkToken.balanceOf.call(provider);

                if (!stake) {
                    const amount = await staking.claimRewards.call(ids, { from: provider });
                    expect(amount).to.be.bignumber.equal(totalRewards);

                    const res = await staking.claimRewards(ids, { from: provider });

                    const event = res.logs[0];
                    expect(event.event).to.eql('RewardsClaimed');
                    expect(event.args.provider).to.eql(provider);
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
                    expect(event.args.provider).to.eql(provider);
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

                const orderedRewards = ids.map((id) => rewards[id]);
                expectEqualArrays(await staking.claimedPositionRewards.call(ids), orderedRewards);

                expect(await staking.rewards.call(ids)).to.be.bignumber.equal(new BN(0));
            };

            beforeEach(async () => {
                await staking.setRewards(
                    ids,
                    ids.map((id) => rewards[id]),
                    { from: distributor }
                );
            });

            it('should return claimable rewards per positions', async () => {
                for (const indexes of [[0], [0, 1, 2, 3], [1, 3], [3, 2, 1, 0], [3, 2]]) {
                    const totalRewards = indexes.reduce((res, index) => res.add(rewards[ids[index]]), new BN(0));

                    expect(await staking.rewards.call(indexes.map((index) => ids[index]))).to.be.bignumber.equal(
                        totalRewards
                    );
                }
            });

            it('should revert when querying for duplicated ids', async () => {
                await expectRevert(staking.rewards.call([ids[0], ids[0]]), 'ERR_DUPLICATE_ID');
                await expectRevert(staking.rewards.call([ids[0], ids[1], ids[0]]), 'ERR_DUPLICATE_ID');
                await expectRevert(staking.rewards.call([ids[1], ids[1], ids[1]]), 'ERR_DUPLICATE_ID');
                await expectRevert(staking.rewards.call([ids[0], ids[1], ids[2], ids[0]]), 'ERR_DUPLICATE_ID');
            });

            it('should claim all pending rewards', async () => {
                await testRewards(ids, provider);
            });

            it('should revert when claiming rewards twice', async () => {
                await testRewards(ids, provider);
                await expectRevert(staking.claimRewards(ids, { from: provider }), 'ERR_NO_REWARDS');
            });

            it('should revert when claiming the same id twice', async () => {
                await expectRevert(staking.claimRewards([ids[0], ids[0]], { from: provider }), 'ERR_DUPLICATE_ID');
            });

            it('should claim and stake all pending rewards', async () => {
                await testRewards(ids, provider, true);
            });

            it('should revert when claiming and staking the same id twice', async () => {
                await expectRevert(
                    staking.stakeRewards([ids[0], ids[0]], poolToken2, { from: provider }),
                    'ERR_DUPLICATE_ID'
                );
            });

            it('should update total position claimed rewards when claiming', async () => {
                const id = ids[0];

                await staking.claimRewards([id], { from: provider });
                expect((await staking.claimedPositionRewards.call([id]))[0]).to.be.bignumber.equal(rewards[id]);

                const reward = new BN(999999999999);
                await staking.setRewards([id], [reward], { from: distributor });
                await staking.claimRewards([id], { from: provider });
                expect((await staking.claimedPositionRewards.call([id]))[0]).to.be.bignumber.equal(reward);
            });

            it('should update total position claimed rewards when staking', async () => {
                const id = ids[0];

                await staking.stakeRewards([id], poolToken2, { from: provider });
                expect((await staking.claimedPositionRewards.call([id]))[0]).to.be.bignumber.equal(rewards[id]);

                const reward = new BN(999999999999);
                await staking.setRewards([id], [reward], { from: distributor });
                await staking.stakeRewards([id], poolToken2, { from: provider });
                expect((await staking.claimedPositionRewards.call([id]))[0]).to.be.bignumber.equal(reward);
            });

            it('should update total provider claimed rewards when claiming', async () => {
                const id = ids[0];

                const prevReward = await staking.rewards.call([id]);
                await staking.claimRewards([id], { from: provider });
                const claimed = await staking.claimedProviderRewards.call(provider);

                const reward = new BN(999999999999);
                await staking.setRewards([id], [reward], { from: distributor });
                await staking.claimRewards([id], { from: provider });
                expect(await staking.claimedProviderRewards.call(provider)).to.be.bignumber.equal(
                    claimed.add(reward.sub(prevReward))
                );
            });

            it('should update total provider claimed rewards when staking', async () => {
                const id = ids[0];

                const prevReward = await staking.rewards.call([id]);
                await staking.stakeRewards([id], poolToken2, { from: provider });
                const claimed = await staking.claimedProviderRewards.call(provider);

                const reward = new BN(999999999999);
                await staking.setRewards([id], [reward], { from: distributor });
                await staking.stakeRewards([id], poolToken2, { from: provider });
                expect(await staking.claimedProviderRewards.call(provider)).to.be.bignumber.equal(
                    claimed.add(reward.sub(prevReward))
                );
            });

            it('should allow updating the claimed rewards after claiming', async () => {
                const id = ids[0];
                const provider = providers[0];

                await testRewards(ids, provider);
                const claimedRewards = await staking.claimedPositionRewards.call([id]);
                const claimedProviderRewards = await staking.claimedProviderRewards.call(provider);
                expect(claimedRewards[0]).to.be.bignumber.gt(new BN(0));
                expect(claimedProviderRewards).to.be.bignumber.gt(new BN(0));

                const reward = new BN(999999999999);
                await staking.updateClaimedRewards([id], [reward], { from: distributor });
                expect((await staking.claimedPositionRewards.call([id]))[0]).to.be.bignumber.equal(reward);
                expect(await staking.claimedProviderRewards.call(provider)).to.be.bignumber.equal(
                    claimedProviderRewards.add(reward).sub(claimedRewards[0])
                );
            });

            it('should allow updating the claimed rewards after claiming', async () => {
                const id = ids[0];
                const provider = providers[0];

                await testRewards(ids, provider, true);
                const claimedRewards = await staking.claimedPositionRewards.call([id]);
                const claimedProviderRewards = await staking.claimedProviderRewards.call(provider);
                expect(claimedRewards[0]).to.be.bignumber.gt(new BN(0));
                expect(claimedProviderRewards).to.be.bignumber.gt(new BN(0));

                const reward = new BN(999999999999);
                await staking.updateClaimedRewards([id], [reward], { from: distributor });
                expect((await staking.claimedPositionRewards.call([id]))[0]).to.be.bignumber.equal(reward);
                expect(await staking.claimedProviderRewards.call(provider)).to.be.bignumber.equal(
                    claimedProviderRewards.add(reward).sub(claimedRewards[0])
                );
            });
        });
    });
});
