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
const StakingRewardsStore = contract.fromArtifact('TestStakingRewardsStore');
const StakingRewards = contract.fromArtifact('TestStakingRewards');

const LIQUIDITY_PROTECTION = web3.utils.asciiToHex('LiquidityProtection');

const ROLE_SUPERVISOR = web3.utils.keccak256('ROLE_SUPERVISOR');
const ROLE_REWARDS_DISTRIBUTOR = web3.utils.keccak256('ROLE_REWARDS_DISTRIBUTOR');
const ROLE_OWNER = web3.utils.keccak256('ROLE_OWNER');
const ROLE_GOVERNOR = web3.utils.keccak256('ROLE_GOVERNOR');
const ROLE_MINTER = web3.utils.keccak256('ROLE_MINTER');

const PPM_RESOLUTION = new BN(1000000);
const MULTIPLIER_INCREMENT = PPM_RESOLUTION.div(new BN(4)); // 25%
const REWARDS_DURATION = duration.weeks(12);
const BIG_POOL_REWARD_RATE = new BN(200000)
    .div(new BN(2))
    .mul(new BN(10).pow(new BN(18)))
    .div(duration.weeks(1));
const SMALL_POOL_REWARD_RATE = new BN(20000)
    .div(new BN(2))
    .mul(new BN(10).pow(new BN(18)))
    .div(duration.weeks(1));

const expectEqualArrays = (arr1, arr2) => {
    expect(arr1.map((x) => x.toString())).to.be.equalTo(arr2.map((x) => x.toString()));
};

const getRewardsMultiplier = (stakingDuration) => {
    // For 0 <= x <= 1 weeks: 100% PPM
    if (stakingDuration.gte(duration.weeks(0)) && stakingDuration.lt(duration.weeks(1))) {
        return PPM_RESOLUTION;
    }

    // For 1 <= x <= 2 weeks: 125% PPM
    if (stakingDuration.gte(duration.weeks(1)) && stakingDuration.lt(duration.weeks(2))) {
        return PPM_RESOLUTION.add(MULTIPLIER_INCREMENT);
    }

    // For 2 <= x <= 3 weeks: 150% PPM
    if (stakingDuration.gte(duration.weeks(2)) && stakingDuration.lt(duration.weeks(3))) {
        return PPM_RESOLUTION.add(MULTIPLIER_INCREMENT.mul(new BN(2)));
    }

    // For 3 <= x < 4 weeks: 175% PPM
    if (stakingDuration.gte(duration.weeks(3)) && stakingDuration.lt(duration.weeks(4))) {
        return PPM_RESOLUTION.add(MULTIPLIER_INCREMENT.mul(new BN(3)));
    }

    // For x >= 4 weeks: 200% PPM
    return PPM_RESOLUTION.mul(new BN(2));
};

describe.only('StakingRewards', () => {
    let now;
    let prevNow;
    let contractRegistry;
    let reserveToken;
    let networkToken;
    let poolToken;
    let poolToken2;
    let checkpointStore;
    let networkTokenGovernance;
    let liquidityProtection;
    let store;
    let staking;

    const supervisor = defaultSender;

    const setTime = async (time) => {
        prevNow = now;
        now = time;

        for (const t of [checkpointStore, store, staking]) {
            if (t) {
                await t.setTime(now);
            }
        }
    };

    beforeEach(async () => {
        contractRegistry = await ContractRegistry.new();

        networkToken = await TestERC20Token.new('TKN1', 'TKN1');
        reserveToken = await TestERC20Token.new('RSV1', 'RSV1');

        poolToken = await TestERC20Token.new('POOL1', 'POOL1');
        poolToken2 = await TestERC20Token.new('POOL2', 'POOL2');

        networkTokenGovernance = await TokenGovernance.new(networkToken.address);
        await networkTokenGovernance.grantRole(ROLE_GOVERNOR, supervisor);
        await networkToken.transferOwnership(networkTokenGovernance.address);
        await networkTokenGovernance.acceptTokenOwnership();

        checkpointStore = await CheckpointStore.new();

        store = await StakingRewardsStore.new();
        staking = await StakingRewards.new(
            store.address,
            networkTokenGovernance.address,
            checkpointStore.address,
            contractRegistry.address
        );

        liquidityProtection = await LiquidityProtection.new(staking.address);
        await contractRegistry.registerAddress(LIQUIDITY_PROTECTION, liquidityProtection.address);

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
        });

        it('should revert if initialized with a zero address store', async () => {
            await expectRevert(
                StakingRewards.new(
                    ZERO_ADDRESS,
                    networkTokenGovernance.address,
                    checkpointStore.address,
                    contractRegistry.address
                ),
                'ERR_INVALID_ADDRESS'
            );
        });

        it('should revert if initialized with a zero address network governance', async () => {
            await expectRevert(
                StakingRewards.new(store.address, ZERO_ADDRESS, checkpointStore.address, contractRegistry.address),
                'ERR_INVALID_ADDRESS'
            );
        });

        it('should revert if initialized with a zero address checkpoint store', async () => {
            await expectRevert(
                StakingRewards.new(
                    store.address,
                    networkTokenGovernance.address,
                    ZERO_ADDRESS,
                    contractRegistry.address
                ),
                'ERR_INVALID_ADDRESS'
            );
        });

        it('should revert if initialized with a zero address registry', async () => {
            await expectRevert(
                StakingRewards.new(
                    store.address,
                    networkTokenGovernance.address,
                    checkpointStore.address,
                    ZERO_ADDRESS
                ),
                'ERR_INVALID_ADDRESS'
            );
        });
    });

    describe('notifications', async () => {
        const provider = accounts[1];
        const provider2 = accounts[2];
        const id = new BN(123);
        const liquidityProtectionProxy = accounts[3];
        const nonLiquidityProtection = accounts[9];

        beforeEach(async () => {
            await contractRegistry.registerAddress(LIQUIDITY_PROTECTION, liquidityProtectionProxy);

            await store.addPoolProgram(poolToken.address, now, now.add(REWARDS_DURATION), BIG_POOL_REWARD_RATE);
        });

        it('should revert when a non-LP contract attempts to notify', async () => {
            await expectRevert(
                staking.addLiquidity(provider, poolToken.address, reserveToken.address, 0, 0, id, {
                    from: nonLiquidityProtection
                }),
                'ERR_ACCESS_DENIED'
            );

            await expectRevert(
                staking.removeLiquidity(provider, poolToken.address, reserveToken.address, 0, 0, id, {
                    from: nonLiquidityProtection
                }),
                'ERR_ACCESS_DENIED'
            );
        });

        it('should revert when notifying for a zero provider ', async () => {
            await expectRevert(
                staking.addLiquidity(ZERO_ADDRESS, poolToken.address, reserveToken.address, 0, 0, id, {
                    from: liquidityProtectionProxy
                }),
                'ERR_INVALID_EXTERNAL_ADDRESS'
            );

            await expectRevert(
                staking.removeLiquidity(ZERO_ADDRESS, poolToken.address, reserveToken.address, 0, 0, id, {
                    from: liquidityProtectionProxy
                }),
                'ERR_INVALID_EXTERNAL_ADDRESS'
            );
        });

        it('should revert when notifying for a non-whitelisted pool token', async () => {
            await expectRevert(
                staking.addLiquidity(provider, poolToken2.address, reserveToken.address, 0, 0, id, {
                    from: liquidityProtectionProxy
                }),
                'ERR_POOL_NOT_WHITELISTED'
            );

            await expectRevert(
                staking.removeLiquidity(provider, poolToken2.address, reserveToken.address, 0, 0, id, {
                    from: liquidityProtectionProxy
                }),
                'ERR_POOL_NOT_WHITELISTED'
            );
        });

        it('should revert when notifying for a zero reserve token ', async () => {
            await expectRevert(
                staking.addLiquidity(provider, poolToken.address, ZERO_ADDRESS, 0, 0, id, {
                    from: liquidityProtectionProxy
                }),
                'ERR_INVALID_EXTERNAL_ADDRESS'
            );

            await expectRevert(
                staking.removeLiquidity(provider, poolToken.address, ZERO_ADDRESS, 0, 0, id, {
                    from: liquidityProtectionProxy
                }),
                'ERR_INVALID_EXTERNAL_ADDRESS'
            );
        });

        it('should reflect on provider and total reserve amounts', async () => {
            // Check the initial state.
            expect(
                await staking.providerReserveAmount.call(provider, poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(new BN(0));
            expect(
                await staking.providerReserveAmount.call(provider2, poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(new BN(0));
            expect(
                await staking.totalReserveAmount.call(poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(new BN(0));

            // Add some liquidity for the first provider.
            const amount = new BN(1000);
            await staking.addLiquidity(provider, poolToken.address, reserveToken.address, 0, amount, id, {
                from: liquidityProtectionProxy
            });

            expect(
                await staking.providerReserveAmount.call(provider, poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(amount);
            expect(
                await staking.providerReserveAmount.call(provider2, poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(new BN(0));
            expect(
                await staking.totalReserveAmount.call(poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(amount);

            // Add some liquidity for the second provider.
            const amount2 = new BN(12345);
            await staking.addLiquidity(provider2, poolToken.address, reserveToken.address, 0, amount2, id, {
                from: liquidityProtectionProxy
            });

            expect(
                await staking.providerReserveAmount.call(provider, poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(amount);
            expect(
                await staking.providerReserveAmount.call(provider2, poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(amount2);
            expect(
                await staking.totalReserveAmount.call(poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(amount.add(amount2));

            // Remove some of first provider's liquidity.
            const removedAmount = new BN(5);
            await staking.removeLiquidity(provider, poolToken.address, reserveToken.address, 0, removedAmount, id, {
                from: liquidityProtectionProxy
            });

            expect(
                await staking.providerReserveAmount.call(provider, poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(amount.sub(removedAmount));
            expect(
                await staking.providerReserveAmount.call(provider2, poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(amount2);
            expect(
                await staking.totalReserveAmount.call(poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(amount.sub(removedAmount).add(amount2));

            // Remove first provider's full liquidity.
            await staking.removeLiquidity(
                provider,
                poolToken.address,
                reserveToken.address,
                0,
                amount.sub(removedAmount),
                id,
                {
                    from: liquidityProtectionProxy
                }
            );

            expect(
                await staking.providerReserveAmount.call(provider, poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(new BN(0));
            expect(
                await staking.providerReserveAmount.call(provider2, poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(amount2);
            expect(
                await staking.totalReserveAmount.call(poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(amount2);

            // Remove second provider's liquidity.
            await staking.removeLiquidity(provider2, poolToken.address, reserveToken.address, 0, amount2, id, {
                from: liquidityProtectionProxy
            });

            expect(
                await staking.providerReserveAmount.call(provider, poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(new BN(0));
            expect(
                await staking.providerReserveAmount.call(provider2, poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(new BN(0));
            expect(
                await staking.totalReserveAmount.call(poolToken.address, reserveToken.address)
            ).to.be.bignumber.equal(new BN(0));
        });
    });

    describe('rewards', async () => {
        const provider = accounts[1];

        let programStartTime;
        let programEndTime;

        beforeEach(async () => {
            await setTime(now);

            programStartTime = now.add(duration.weeks(1));
            programEndTime = programStartTime.add(REWARDS_DURATION);

            await store.addPoolProgram(poolToken.address, programStartTime, programEndTime, BIG_POOL_REWARD_RATE);
        });

        context('single pool', async () => {
            const reserveAmount = new BN(1000);
            let totalReserveAmount;

            beforeEach(async () => {
                await liquidityProtection.addLiquidity(
                    provider,
                    poolToken.address,
                    reserveToken.address,
                    reserveAmount
                );

                totalReserveAmount = reserveAmount;
            });

            context('single sided staking', async () => {
                it('should properly calculate all staking rewards', async () => {
                    // Should return no rewards before the program has started.
                    let reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(new BN(0));

                    // Should return no rewards immediately when the program has started.
                    await setTime(programStartTime);

                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(new BN(0));

                    // Should return all rewards for one second.
                    await setTime(now.add(duration.seconds(1)));

                    let expectedReward = reserveAmount.mul(BIG_POOL_REWARD_RATE.div(totalReserveAmount));
                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(expectedReward);

                    // Should return all rewards for a single day.
                    await setTime(programStartTime.add(duration.days(1)));

                    expectedReward = reserveAmount.mul(
                        duration.days(1).mul(BIG_POOL_REWARD_RATE).div(totalReserveAmount)
                    );
                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(expectedReward);

                    // Should return all weekly rewards + second week's retroactive multiplier.
                    await setTime(programStartTime.add(duration.weeks(1)));

                    expectedReward = reserveAmount
                        .mul(duration.weeks(1).mul(BIG_POOL_REWARD_RATE).div(totalReserveAmount))
                        .mul(getRewardsMultiplier(duration.weeks(1)))
                        .div(PPM_RESOLUTION);
                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(expectedReward);

                    // Should return all program rewards + max retroactive multipliers.
                    await setTime(programEndTime);

                    const programDuration = programEndTime.sub(programStartTime);
                    expectedReward = reserveAmount
                        .mul(programDuration.mul(BIG_POOL_REWARD_RATE).div(totalReserveAmount))
                        .mul(getRewardsMultiplier(duration.weeks(4)))
                        .div(PPM_RESOLUTION);
                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(expectedReward);

                    // Should not affect rewards after the ending time of the program.
                    await setTime(programEndTime.add(duration.days(1)));

                    const reward2 = await staking.rewards.call({ from: provider });
                    expect(reward2).to.be.bignumber.equal(reward);
                });

                it('should claim all staking rewards', async () => {
                    // Should return no rewards before the program has started.
                    let reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(new BN(0));

                    await expectRevert(staking.claimRewards({ from: provider }), 'ERR_NO_REWARDS');

                    // Should return no rewards immediately when the program has started.
                    await setTime(programStartTime);

                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(new BN(0));

                    await expectRevert(staking.claimRewards({ from: provider }), 'ERR_NO_REWARDS');

                    // Should grant all rewards for one second.
                    await setTime(now.add(duration.seconds(1)));

                    let expectedReward = reserveAmount.mul(
                        now.sub(prevNow).mul(BIG_POOL_REWARD_RATE.div(totalReserveAmount))
                    );
                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(expectedReward);

                    let prevBalance = await networkToken.balanceOf.call(provider);
                    await staking.claimRewards({ from: provider });
                    expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(prevBalance.add(reward));
                    expect(await staking.rewards.call({ from: provider })).to.be.bignumber.equal(new BN(0));

                    // Should return all rewards for a single day, excluding previously granted rewards.
                    await setTime(programStartTime.add(duration.days(1)));

                    expectedReward = reserveAmount.mul(
                        now.sub(prevNow).mul(BIG_POOL_REWARD_RATE).div(totalReserveAmount)
                    );
                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(expectedReward);

                    prevBalance = await networkToken.balanceOf.call(provider);
                    await staking.claimRewards({ from: provider });
                    expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(prevBalance.add(reward));
                    expect(await staking.rewards.call({ from: provider })).to.be.bignumber.equal(new BN(0));

                    // Should return all weekly rewards, excluding previously granted rewards, but without the
                    // multiplier bonus.
                    await setTime(programStartTime.add(duration.weeks(1)));

                    expectedReward = reserveAmount.mul(
                        now.sub(prevNow).mul(BIG_POOL_REWARD_RATE).div(totalReserveAmount)
                    );
                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(expectedReward);

                    prevBalance = await networkToken.balanceOf.call(provider);
                    await staking.claimRewards({ from: provider });
                    expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(prevBalance.add(reward));
                    expect(await staking.rewards.call({ from: provider })).to.be.bignumber.equal(new BN(0));

                    // Should return all the rewards for the two weeks, excluding previously granted rewards, with the
                    // two weeks rewards multiplier.
                    await setTime(programStartTime.add(duration.weeks(3)));

                    expectedReward = reserveAmount
                        .mul(now.sub(prevNow).mul(BIG_POOL_REWARD_RATE).div(totalReserveAmount))
                        .mul(getRewardsMultiplier(duration.weeks(2)))
                        .div(PPM_RESOLUTION);
                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(expectedReward);

                    prevBalance = await networkToken.balanceOf.call(provider);
                    await staking.claimRewards({ from: provider });
                    expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(prevBalance.add(reward));
                    expect(await staking.rewards.call({ from: provider })).to.be.bignumber.equal(new BN(0));

                    // Should return all program rewards, excluding previously granted rewards + max retroactive
                    // multipliers.
                    await setTime(programEndTime);

                    expectedReward = reserveAmount
                        .mul(now.sub(prevNow).mul(BIG_POOL_REWARD_RATE).div(totalReserveAmount))
                        .mul(getRewardsMultiplier(duration.weeks(4)))
                        .div(PPM_RESOLUTION);
                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(expectedReward);

                    prevBalance = await networkToken.balanceOf.call(provider);
                    await staking.claimRewards({ from: provider });
                    expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(prevBalance.add(reward));
                    expect(await staking.rewards.call({ from: provider })).to.be.bignumber.equal(new BN(0));

                    // Should return no additional rewards after the ending time of the program.
                    await setTime(programEndTime.add(duration.days(1)));

                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(new BN(0));
                });
            });

            context('double sided staking', async () => {
                const reserveAmount2 = new BN(9999999);
                let totalReserveAmount2;

                beforeEach(async () => {
                    await liquidityProtection.addLiquidity(
                        provider,
                        poolToken.address,
                        networkToken.address,
                        reserveAmount2
                    );

                    totalReserveAmount2 = reserveAmount2;
                });

                it('should properly calculate all staking rewards', async () => {
                    // Should return no rewards before the program has started.
                    let reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(new BN(0));

                    // Should return no rewards immediately when the program has started.
                    await setTime(programStartTime);

                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(new BN(0));

                    // Should return all reserve tokens rewards for one second.
                    await setTime(now.add(duration.seconds(1)));

                    let expectedReward1 = reserveAmount.mul(BIG_POOL_REWARD_RATE.div(totalReserveAmount));
                    let expectedReward2 = reserveAmount2.mul(BIG_POOL_REWARD_RATE.div(totalReserveAmount2));
                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(expectedReward1.add(expectedReward2));

                    // Should return all rewards for a single day.
                    await setTime(programStartTime.add(duration.days(1)));

                    expectedReward1 = reserveAmount.mul(
                        duration.days(1).mul(BIG_POOL_REWARD_RATE).div(totalReserveAmount)
                    );
                    expectedReward2 = reserveAmount2.mul(
                        duration.days(1).mul(BIG_POOL_REWARD_RATE).div(totalReserveAmount2)
                    );
                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(expectedReward1.add(expectedReward2));

                    // Should return all weekly rewards + second week's retroactive multiplier.
                    await setTime(programStartTime.add(duration.weeks(1)));

                    expectedReward1 = reserveAmount
                        .mul(duration.weeks(1).mul(BIG_POOL_REWARD_RATE).div(totalReserveAmount))
                        .mul(getRewardsMultiplier(duration.weeks(1)))
                        .div(PPM_RESOLUTION);
                    expectedReward2 = reserveAmount2
                        .mul(duration.weeks(1).mul(BIG_POOL_REWARD_RATE).div(totalReserveAmount2))
                        .mul(getRewardsMultiplier(duration.weeks(1)))
                        .div(PPM_RESOLUTION);
                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(expectedReward1.add(expectedReward2));

                    // Should return all program rewards + max retroactive multipliers.
                    await setTime(programEndTime);

                    const programDuration = programEndTime.sub(programStartTime);
                    expectedReward1 = reserveAmount
                        .mul(programDuration.mul(BIG_POOL_REWARD_RATE).div(totalReserveAmount))
                        .mul(getRewardsMultiplier(duration.weeks(4)))
                        .div(PPM_RESOLUTION);
                    expectedReward2 = reserveAmount2
                        .mul(programDuration.mul(BIG_POOL_REWARD_RATE).div(totalReserveAmount2))
                        .mul(getRewardsMultiplier(duration.weeks(4)))
                        .div(PPM_RESOLUTION);
                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(expectedReward1.add(expectedReward2));

                    // Should not affect rewards after the ending time of the program.
                    await setTime(programEndTime.add(duration.days(1)));

                    const reward2 = await staking.rewards.call({ from: provider });
                    expect(reward2).to.be.bignumber.equal(reward);
                });

                it('should claim all staking rewards', async () => {
                    // Should return no rewards before the program has started.
                    let reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(new BN(0));

                    await expectRevert(staking.claimRewards({ from: provider }), 'ERR_NO_REWARDS');

                    // Should return no rewards immediately when the program has started.
                    await setTime(programStartTime);

                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(new BN(0));

                    await expectRevert(staking.claimRewards({ from: provider }), 'ERR_NO_REWARDS');

                    // Should grant all rewards for one second.
                    await setTime(now.add(duration.seconds(1)));

                    let expectedReward1 = reserveAmount.mul(
                        now.sub(prevNow).mul(BIG_POOL_REWARD_RATE.div(totalReserveAmount))
                    );
                    let expectedReward2 = reserveAmount2.mul(
                        now.sub(prevNow).mul(BIG_POOL_REWARD_RATE.div(totalReserveAmount2))
                    );
                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(expectedReward1.add(expectedReward2));

                    let prevBalance = await networkToken.balanceOf.call(provider);
                    await staking.claimRewards({ from: provider });
                    expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(prevBalance.add(reward));
                    expect(await staking.rewards.call({ from: provider })).to.be.bignumber.equal(new BN(0));

                    // Should return all rewards for a single day, excluding previously granted rewards.
                    await setTime(programStartTime.add(duration.days(1)));

                    expectedReward1 = reserveAmount.mul(
                        now.sub(prevNow).mul(BIG_POOL_REWARD_RATE).div(totalReserveAmount)
                    );
                    expectedReward2 = reserveAmount2.mul(
                        now.sub(prevNow).mul(BIG_POOL_REWARD_RATE).div(totalReserveAmount2)
                    );
                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(expectedReward1.add(expectedReward2));

                    prevBalance = await networkToken.balanceOf.call(provider);
                    await staking.claimRewards({ from: provider });
                    expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(prevBalance.add(reward));
                    expect(await staking.rewards.call({ from: provider })).to.be.bignumber.equal(new BN(0));

                    // Should return all weekly rewards, excluding previously granted rewards, but without the
                    // multiplier bonus.
                    await setTime(programStartTime.add(duration.weeks(1)));

                    expectedReward1 = reserveAmount.mul(
                        now.sub(prevNow).mul(BIG_POOL_REWARD_RATE).div(totalReserveAmount)
                    );

                    expectedReward2 = reserveAmount2.mul(
                        now.sub(prevNow).mul(BIG_POOL_REWARD_RATE).div(totalReserveAmount2)
                    );
                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(expectedReward1.add(expectedReward2));

                    prevBalance = await networkToken.balanceOf.call(provider);
                    await staking.claimRewards({ from: provider });
                    expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(prevBalance.add(reward));
                    expect(await staking.rewards.call({ from: provider })).to.be.bignumber.equal(new BN(0));

                    // Should return all the rewards for the two weeks, excluding previously granted rewards, with the
                    // two weeks rewards multiplier.
                    await setTime(programStartTime.add(duration.weeks(3)));

                    expectedReward1 = reserveAmount
                        .mul(now.sub(prevNow).mul(BIG_POOL_REWARD_RATE).div(totalReserveAmount))
                        .mul(getRewardsMultiplier(duration.weeks(2)))
                        .div(PPM_RESOLUTION);
                    expectedReward2 = reserveAmount2
                        .mul(now.sub(prevNow).mul(BIG_POOL_REWARD_RATE).div(totalReserveAmount2))
                        .mul(getRewardsMultiplier(duration.weeks(2)))
                        .div(PPM_RESOLUTION);
                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(expectedReward1.add(expectedReward2));

                    prevBalance = await networkToken.balanceOf.call(provider);
                    await staking.claimRewards({ from: provider });
                    expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(prevBalance.add(reward));
                    expect(await staking.rewards.call({ from: provider })).to.be.bignumber.equal(new BN(0));

                    // Should return all program rewards, excluding previously granted rewards + max retroactive
                    // multipliers.
                    await setTime(programEndTime);

                    expectedReward1 = reserveAmount
                        .mul(now.sub(prevNow).mul(BIG_POOL_REWARD_RATE).div(totalReserveAmount))
                        .mul(getRewardsMultiplier(duration.weeks(4)))
                        .div(PPM_RESOLUTION);
                    expectedReward2 = reserveAmount2
                        .mul(now.sub(prevNow).mul(BIG_POOL_REWARD_RATE).div(totalReserveAmount2))
                        .mul(getRewardsMultiplier(duration.weeks(4)))
                        .div(PPM_RESOLUTION);
                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(expectedReward1.add(expectedReward2));

                    prevBalance = await networkToken.balanceOf.call(provider);
                    await staking.claimRewards({ from: provider });
                    expect(await networkToken.balanceOf.call(provider)).to.be.bignumber.equal(prevBalance.add(reward));
                    expect(await staking.rewards.call({ from: provider })).to.be.bignumber.equal(new BN(0));

                    // Should return no additional rewards after the ending time of the program.
                    await setTime(programEndTime.add(duration.days(1)));

                    reward = await staking.rewards.call({ from: provider });
                    expect(reward).to.be.bignumber.equal(new BN(0));
                });
            });
        });
    });
});
