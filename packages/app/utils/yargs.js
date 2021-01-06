const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const { argv } = yargs(hideBin(process.argv))
    .option('verbose', {
        alias: 'v',
        type: 'boolean',
        description: 'Run with verbose logging'
    })
    .option('multiline', {
        alias: 'm',
        type: 'boolean',
        description: 'Format log arguments in multiple lines'
    })
    .option('test', {
        alias: 't',
        type: 'boolean',
        description: 'Run in test mode'
    })
    .option('init', {
        alias: 'i',
        type: 'boolean',
        description: 'Deploy new contracts for testing (test mode only)'
    })
    .option('reorg-offset', {
        alias: 'r',
        type: 'number',
        default: 500,
        description: 'Reorg blocks offset to take into account'
    })
    .option('gas-price', {
        alias: 'g',
        type: 'number',
        description: 'The gas price in wei to use for setting transactions (in gwei)'
    })
    .option('get-all', {
        type: 'boolean',
        description: 'Get all data'
    })
    .option('get-liquidity', {
        type: 'boolean',
        description: 'Get all liquidity changes'
    })
    .option('get-positions', {
        type: 'boolean',
        description: 'Get all positions'
    })
    .option('get-last-removal-times', {
        type: 'boolean',
        description: 'Get last removal times for all providers'
    })
    .option('get-rewards', {
        type: 'boolean',
        description: 'Get all rewards'
    })

    .option('set-all', {
        type: 'boolean',
        description: 'Set all data'
    })
    .option('set-last-removal-times', {
        type: 'boolean',
        description: 'Set last removal times for all providers'
    })
    .option('set-programs', {
        type: 'boolean',
        description: 'Set reward programs'
    });

module.exports = argv;
