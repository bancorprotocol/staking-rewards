const chalk = require('chalk');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const moment = require('moment');

const { verbose } = yargs(hideBin(process.argv)).option('verbose', {
    alias: 'v',
    type: 'boolean',
    description: 'Run with verbose logging'
}).argv;

const now = () => {
    return `[${moment().format('DD-MM|HH:mm:ss')}]`;
};

const error = (...data) => {
    console.log(chalk.bold.red('ERROR'), now(), ...data);

    process.exit(1);
};

const warning = (...data) => {
    console.log(chalk.yellow('WARN'), now(), ...data);
};

const notice = (...data) => {
    console.log(chalk.cyan('NOTICE'), now(), ...data);
};

const info = (...data) => {
    console.log(chalk.green('INFO'), now(), ...data);
};

const trace = (...data) => {
    if (verbose) {
        console.log(chalk.gray('TRACE'), now(), ...data);
    }
};

const arg = (message, value) => `${chalk.green(message)}=${value}`;

module.exports = {
    error,
    warning,
    notice,
    info,
    trace,
    arg
};
