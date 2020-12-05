const chalk = require('chalk');

const error = (...data) => {
    console.log(chalk.bold.red('ERROR', ...data));
};

const warning = (...data) => {
    console.log(chalk.yellow('WARN', ...data));
};

const info = (...data) => {
    console.log(chalk.green('INFO'), ...data);
};

module.exports = {
    error,
    warning,
    info
};
