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
    .option('get-liquidity', {
        type: 'boolean',
        description: 'Get all liquidity changes'
    });

module.exports = argv;
