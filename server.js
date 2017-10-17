// server.js

'use strict';

require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const mongoDB = require('./app/db');
const logger = require('./app/utils').logger();
const routes = require('./app/routes');
const iamportService = require('./app/iamport/iamport.service');
const payoutService = require('./app/payout/payout.service');

const app = express();
const port = process.env.PORT;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

mongoDB.connect((err) => {
    app.use('/', routes);

    iamportService.initialize();
    payoutService.initialize();

    app.listen(port, () => {
        logger.debug(`we are live on ${port}`);
    });
});
