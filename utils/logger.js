const chalk = require('chalk');
const moment = require('moment');

let verbose = false;
let multiline = false;

const setVerbose = (state) => {
    verbose = state;
};

const setMultiline = (state) => {
    multiline = state;
};

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

const info = (...data) => {
    console.log(chalk.green('INFO'), now(), ...data);
};

const trace = (...data) => {
    if (verbose) {
        console.log(chalk.cyan('TRACE'), now(), ...data);
    }
};

const arg = (message, value) => `${multiline ? '\n  ' : ''}${chalk.green(message)}=${value}`;

module.exports = {
    setVerbose,
    setMultiline,
    error,
    warning,
    info,
    trace,
    arg
};
