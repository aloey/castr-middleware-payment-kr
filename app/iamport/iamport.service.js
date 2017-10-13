// app/iamport/iamport.service.js

'use strict';

const mongoDB = require('../db');
const logger = require('../utils').logger();
const moment = require('../utils').moment();
const nodemailer = require('../utils').nodemailer();
const Iamport = require('iamport');

const timezone = {
    seoul: 'ASIA/SEOUL',
    utc: 'UTC',
};

const billing_plan_type = {
    '4_WEEK': 4,
    '26_WEEK': 26,
    '52_WEEK': 52,
};

const payment_type = {
    initial: 'INITIAL',
    scheduled: 'SCHEDULED',
    refund: 'REFUND',
};

const status_type = {
    paid: 'PAID',
    cancelled: 'REFUNDED',
    failed: 'FAILED',
    pending: 'PENDING',
};

class IamportService {
    /**
     * I'mport service class constructor.
     */
    constructor() {
        this.iamport = new Iamport({
            impKey: process.env.IAMPORT_APIKEY,
            impSecret: process.env.IAMPORT_SECRET,
        });
    }

    /**
     * Triggers checking payment schedules at 6 am everyday (local time).
     */
    checkScheduleAt6AM() {
        const full_day = 24 * 60 * 60 * 1000;
        const utc_now = moment.tz(timezone.utc);
        const local_next_morning = moment(utc_now).add(1, 'day').tz(timezone.seoul).hour(6).minute(0).second(0).millisecond(0);
        // Calculate time until next 6 am
        const time_until = local_next_morning.diff(utc_now) % full_day;
        // Check for scheduled payments at next 6 am
        const callback = function () {
            this._checkScheduledPayments();
        };
        setTimeout(callback.bind(this), time_until);
        logger.debug(`Next schedule check scheduled at ${(time_until / 3600000).toFixed(2)} hours later.`);
    }

    /**
     * Checks the payment schedules and process them.
     * This runs daily at 6 am (local time).
     */
    _checkScheduledPayments() {
        logger.debug(`Checking for payments scheduled on ${moment.tz(timezone.seoul).format('LL')}.`);
        // Result arrays
        const promises = [];
        const successes = [];
        const failures = [];
        // Find all scheduled payments with PENDING status for today and before
        mongoDB.getDB().collection('payment-schedule').find(
            {
                status: status_type.pending,
                schedule: { $lte: moment.tz(timezone.seoul).hour(0).minute(0).second(0).millisecond(0).toDate() },
            },
            (db_error, cursor) => {
                cursor.forEach(
                    // Iteration callback
                    (document) => {
                        const schedule_params = {
                            business_id: document.business_id,
                            merchant_uid: document.merchant_uid,
                            type: payment_type.scheduled,
                            billing_plan: document.billing_plan,
                            pay_date: document.schedule,
                            amount: document.amount,
                            vat: document.vat,
                        };
                        // Make the payment
                        promises.push(this.pay(schedule_params)
                            .then((result) => {
                                successes.push(`\n - ${result.data.merchant_uid}: ${result.data.amount} ${result.data.currency}`);
                            })
                            .catch((error) => {
                                failures.push(`\n - ${error.params.merchant_uid}: ${error.params.amount}`);
                            }));
                    },
                    // End callback
                    (end) => {
                        Promise.all(promises)
                            .then(() => {
                                logger.debug(`(${successes.length}/${promises.length}) scheduled payment requests approved:${successes}`);
                                if (failures.length !== 0) {
                                    logger.error(`(${failures.length}/${promises.length}) scheduled payment requests failed:${failures}`);
                                }
                            })
                            .catch((err) => {
                                // This shouldn't happen
                                logger.error(err);
                            });
                    }
                );
            }
        );
        // Schdule payment-schedule check at next 6AM
        this.checkScheduleAt6AM();
    }

    /**
     * Fetches all payment methods ('customer_uid') for the business ('business_id').
     * @param {*} req 
     * @param {*} res 
     */
    getPaymentMethods(req, res) {
        // Result arrays
        const promises = [];
        const methods = [];
        // Define iteration callback function
        const iteration_callback = function (document) {
            // Create a promise for each I'mport request
            const params = { customer_uid: document.customer_uid };
            promises.push(this.iamport.subscribe_customer.get(params)
                .then((iamport_result) => {
                    logger.debug(`Successfully fetched payment method (${iamport_result.customer_uid}) from I'mport.`);
                    iamport_result.default_method = document.default_method;
                    methods.push(iamport_result);
                })
                .catch((iamport_error) => {
                    const error = {
                        message: `Failed to fetch payment method (${params.customer_uid}) from I'mport.`,
                        params: params,
                        error: {
                            code: iamport_error.code,
                            message: iamport_error.message,
                        },
                    };
                    logger.error(error);
                    methods.push(error);
                }));
        };
        const end_callback = function (end) {
            Promise.all(promises)
                .then(() => {
                    res.send({
                        sucecss: true,
                        message: `Successfully fetched ${promises.length} payment methods.`,
                        data: methods,
                    });
                })
                .catch((err) => {
                    // Should not happen
                    const error = {
                        message: 'Something went wrong during the end callback of cursor iteration',
                        error: {
                            code: err.code,
                            message: err.message,
                        },
                    };
                    logger.error(error);
                    error.success = false;
                    res.send();
                });
        };
        // Find all payment methods under the business
        mongoDB.getDB().collection('payment-methods').find(
            { business_id: req.params.business_id },
            (db_error, cursor) => {
                cursor.forEach(
                    // Iteration callback
                    iteration_callback.bind(this),
                    // End callback
                    end_callback
                );
            }
        );
    }

    /**
     * Registers a given payment method with I'mport for the business ('business_id').
     * @param {*} req
     * @param {*} res
     */
    createPaymentMethod(req, res) {
        const business_id = req.params.business_id;
        const last_4_digits = req.body.card_number.split('-')[3];
        // Check for I'mport vulnerability
        if (last_4_digits.length !== 4) {
            const msg = `The last 4 digits are not 4 digits long (${last_4_digits}).`;
            logger.error(msg);
            res.send({
                success: false,
                message: msg,
                error: {
                    code: 'castr_payment_error',
                    message: msg,
                },
            });
            return;
        }
        // Request I'mport service
        const customer_uid = `${business_id}_${last_4_digits}`;
        this.iamport.subscribe_customer.create({
            // Required
            customer_uid: customer_uid,
            card_number: req.body.card_number,
            expiry: req.body.expiry,
            birth: req.body.birth,
            pwd_2digit: req.body.pwd_2digit,
            // Optional
            customer_name: req.body.customer_name,
            customer_tel: req.body.customer_tel,
            customer_email: req.body.customer_email,
            customer_addr: req.body.customer_addr,
            customer_postcode: req.body.customer_postcode,
        })
            .then((iamport_result) => {
                logger.debug(`Succesfully registered payment method (${iamport_result.customer_uid}) with I'mport.`);
                // Update this payment method to the business account in castrDB
                mongoDB.getDB().collection('payment-methods').updateOne(
                    {
                        business_id: business_id,
                        customer_uid: iamport_result.customer_uid,
                    },
                    {
                        $setOnInsert: {
                            business_id: business_id,
                            created_time: new Date(),
                        },
                        $set: {
                            customer_uid: iamport_result.customer_uid,
                            default_method: false,
                            updated_time: new Date(),
                        },
                    },
                    { upsert: true }
                );
                res.send({
                    success: true,
                    message: `New payment method (${iamport_result.customer_uid}) has been created.`,
                    data: iamport_result,
                });
            }).catch((iamport_error) => {
                const error = {
                    message: 'Something went wrong with I\'mport while registering new payment method.',
                    params: {
                        business_id: business_id,
                        customer_uid: customer_uid,
                    },
                    error: {
                        code: iamport_error.code,
                        message: iamport_error.message,
                    },
                };
                logger.error(error);
                error.success = false;
                res.send(error);
            });
    }

    /**
     * Removes a given payment method ('customer_uid') from I'mport for the business ('business_id').
     * @param {*} req 
     * @param {*} res 
     */
    deletePaymentMethod(req, res) {
        const params = { customer_uid: req.body.customer_uid };
        this.iamport.subscribe_customer.delete(params)
            .then((iamport_result) => {
                const msg = `Payment method (${iamport_result.customer_uid}) has been removed.`;
                logger.debug(msg);
                mongoDB.getDB().collection('payment-methods').deleteOne({ customer_uid: iamport_result.customer_uid });
                res.send({
                    success: true,
                    message: msg,
                    data: iamport_result,
                });
            }).catch((iamport_error) => {
                const error = {
                    message: 'Something went wrong with I\'mport while removing the payment method.',
                    params: params,
                    error: {
                        code: iamport_error.code,
                        message: iamport_error.message,
                    },
                };
                logger.error(error);
                error.success = false;
                res.send(error);
            });
    }

    /**
     * Sets the provided payment method ('customer_uid') as the default payment method for the business ('business_id').
     * @param {*} req 
     * @param {*} res 
     */
    setAsDefault(req, res) {
        const business_id = req.params.business_id;
        const customer_uid = req.params.customer_uid;
        // Unset the current default method   
        mongoDB.getDB().collection('payment-methods').updateOne(
            {
                business_id: business_id,
                default_method: true,
            },
            { $set: { default_method: false } },
            // Set the provided method as the new default
            (unset_db_error, unset_write_result) => {
                mongoDB.getDB().collection('payment-methods').updateOne(
                    { customer_uid: customer_uid },
                    { $set: { default_method: true } },
                    (set_db_error, set_write_result) => {
                        // If no payment method found, return error
                        if (set_write_result.matchedCount === 0) {
                            const msg = `No payment method was found for the given 'customer_uid' (${customer_uid}).`;
                            logger.error(msg);
                            res.send({
                                success: false,
                                message: msg,
                                error: {
                                    code: 'castr_payment_error',
                                    message: msg,
                                },
                            });
                            return;
                        }
                        logger.debug(`Business (${business_id}): default pay_method changed to ${customer_uid}`);
                        // See if there is any failed scheduled payments
                        mongoDB.getDB().collection('payment-schedule').findOne(
                            {
                                business_id: business_id,
                                status: status_type.failed,
                            },
                            (db_error, failed_payment) => {
                                if (!failed_payment) { return; }
                                if (db_error) { logger.error(db_error); }
                                const schedule_params = {
                                    business_id: failed_payment.business_id,
                                    merchant_uid: failed_payment.merchant_uid,
                                    type: payment_type.scheduled,
                                    billing_plan: failed_payment.billing_plan,
                                    pay_date: moment().toDate(),
                                    amount: failed_payment.amount,
                                    vat: failed_payment.vat,
                                };
                                // Make the payment
                                logger.debug(`[ATTEMPT ${(failed_payment.failures.length + 1)}] Requesting failed scheduled payment (${schedule_params.merchant_uid})`);
                                this.pay(schedule_params)
                                    .then(() => { })
                                    .catch(() => { });
                            }
                        );
                        res.send({
                            success: true,
                            message: `Payment method (${customer_uid}) has been set as default.`,
                            data: { customer_uid: customer_uid },
                        });
                    }
                );
            }
        );
    }

    /**
     * Subscribes the business ('business_id') for recurring payments.
     * @param {*} req 
     * @param {*} res 
     */
    subscribe(req, res) {
        // Validate billing plan
        const billing_plan = req.body.billing_plan;
        if (!billing_plan_type.hasOwnProperty(req.body.billing_plan)) {
            const msg = `'billing_plan' not supported, must provide either: ${Object.keys(billing_plan_type)}.`;
            logger.error(msg);
            res.send({
                success: false,
                message: msg,
                error: {
                    code: 'castr_payment_error',
                    message: msg,
                },
            });
            return;
        }
        const business_id = req.params.business_id;
        const charge_num = req.body.charge_num || 0;
        const merchant_uid = `${business_id}_ch${charge_num}`;
        const subscription_params = {
            business_id: business_id,
            merchant_uid: merchant_uid,
            type: payment_type.initial,
            billing_plan: billing_plan,
            pay_date: moment().toDate(),
            amount: req.body.amount,
            vat: req.body.vat,
        };
        // Process initial payment
        this.pay(subscription_params)
            .then((result) => {
                const msg = `Initial payment requested (${merchant_uid}: ${result.data.amount} ${result.data.currency})`;
                logger.debug(msg);
                res.send({
                    success: true,
                    message: msg,
                    data: result.data,
                });
            })
            .catch((error) => {
                error.message = `Initial payment request failed (${merchant_uid}: ${error.params.amount})`;
                logger.error(error);
                error.success = false;
                res.send(error);
            });
    }

    changeSubscription(req, res) {
        const business_id = req.params.business_id;
        const new_billing_plan = req.body.billing_plan;
        const new_amount = req.body.amount;
        let old_billing_plan;
        let old_amount;
        let schedule;
        mongoDB.getDB().collection('payment-schedule').findOne({
            business_id: req.params.business_id,
            status: { $in: [status_type.pending, status_type.failed] },
        })
            .then((scheduled_payment) => {
                if (!scheduled_payment) {
                    throw Error(`Business (${business_id}) is either invalid, not yet subscribed, or is missing next payment schedule`);
                }
                old_billing_plan = scheduled_payment.billing_plan;
                old_amount = scheduled_payment.amount;
                schedule = scheduled_payment.schedule;
                return mongoDB.getDB().collection('payment-schedule').updateOne(
                    { merchant_uid: scheduled_payment.merchant_uid },
                    {
                        $set: {
                            billing_plan: new_billing_plan,
                            amount: new_amount,
                        },
                    }
                );
            })
            .then((update_result) => {
                const msg = `Business (${business_id}): Subscription change ${old_billing_plan}(${old_amount}) => ${new_billing_plan}(${new_amount})`;
                logger.debug(msg);
                res.send({
                    success: true,
                    message: msg,
                    data: {
                        business_id: business_id,
                        schedule: schedule,
                        old_billing_plan: old_billing_plan,
                        new_billing_plan: new_billing_plan,
                    },
                });
            })
            .catch((error) => {
                logger.error(error.message);
                res.send({
                    success: false,
                    message: error.message,
                    error: error,
                });
            });
    }

    /**
     * Processes a one-time payment using the default payment method set for the business (payment_params.business_id).
     * 
     * Returns a promise.
     * @param {*} payment_params
     */
    pay(payment_params) {
        return new Promise(((resolve, reject) => {
            // Fetch the default payment method
            mongoDB.getDB().collection('payment-methods').findOne(
                {
                    business_id: payment_params.business_id,
                    default_method: true,
                },
                (db_error, default_method) => {
                    // If no default method was found, return error
                    if (default_method === null) {
                        const error = {
                            params: payment_params,
                            error: {
                                code: 'castr_payment_error',
                                message: `Could not find a default payment method for the business (${payment_params.business_id}).`,
                            },
                        };
                        reject(error);
                        return;
                    }
                    const name = this._generateName(payment_params);
                    const params = {
                        merchant_uid: payment_params.merchant_uid,
                        customer_uid: default_method.customer_uid,
                        name: name.short,
                        amount: payment_params.amount,
                        cancel_amount: payment_params.amount,
                        vat: payment_params.vat,
                        custom_data: JSON.stringify({
                            business_id: payment_params.business_id,
                            merchant_uid: payment_params.merchant_uid,
                            customer_uid: default_method.customer_uid,
                            name: name,
                            type: payment_params.type,
                            billing_plan: payment_params.billing_plan,
                            pay_date: payment_params.pay_date,
                            amount: payment_params.amount,
                            cancel_amount: payment_params.amount,
                            vat: payment_params.vat,
                        }),
                    };
                    // Request I'mport for payment
                    this.iamport.subscribe.again(params)
                        .then((iamport_result) => {
                            setTimeout(this.paymentHook, 0, iamport_result);
                            if (status_type[iamport_result.status] === status_type.failed) {
                                const error = {
                                    params: JSON.parse(params.custom_data),
                                    error: {
                                        code: null,
                                        message: iamport_result.fail_reason,
                                    },
                                };
                                reject(error);
                                return;
                            }
                            resolve({ data: iamport_result });
                        })
                        .catch((iamport_error) => {
                            params.custom_data = JSON.parse(params.custom_data);
                            const error = {
                                params: params,
                                error: {
                                    code: iamport_error.code,
                                    message: iamport_error.message,
                                },
                            };
                            reject(error);
                        });
                }
            );
        }));
    }

    pause(req, res) {
        logger.debug('pause invoked.');
    }

    resume(req, res) {
        logger.debug('resume invoked.');
    }

    refund(req, res) {
        logger.debug('refund invoked.');
        // Fetch the latest subscription object (SCHEDULE)
        // Calculate how much time has passed since the last payment
        // Calculate the ratio, PRORATE = {time_passed_since_last_paid} / {billing_plan}
        // (1 - PRORATE) is the {%service_not_yet_received}
        // Refund 80% of {%service_not_yet_received}, (20% is cancellation fee)
    }

    /**
     * Fetches all payment transactions from the business ('business_id').
     * @param {*} req 
     * @param {*} res 
     */
    getHistory(req, res) {
        // Find all payment transactions from the business
        mongoDB.getDB().collection('payment-transactions').find(
            { business_id: req.params.business_id },
            (db_error, cursor) => {
                const methods = [];
                cursor.sort({ time_paid: -1 }).forEach(
                    // Iteration callback
                    (document) => {
                        document.pay_date = {
                            date: document.pay_date,
                            string: moment(document.pay_date).tz(timezone.utc).format('LL'),
                            string_kr: moment(document.pay_date).locale('kr').tz(timezone.seoul).format('LL'),
                        };
                        document.time_paid = {
                            date: document.time_paid,
                            string: moment(document.time_paid).tz(timezone.utc).format('LL'),
                            string_kr: moment(document.time_paid).locale('kr').tz(timezone.seoul).format('LL'),
                        };
                        methods.push(document);
                    },
                    // End callback
                    (end) => {
                        const msg = `Transaction history fetched for business (${req.params.business_id})`;
                        logger.debug(msg);
                        res.send({
                            sucecss: true,
                            message: msg,
                            data: methods,
                        });
                    }
                );
                // TODO: (FOR UPDATE) Use .limit() & .skip() to implement paging
            }
        );
    }

    paymentHook(iamport_result) {
        const status = status_type[iamport_result.status];
        switch (status) {
            case status_type.paid: {
                const custom_data = JSON.parse(iamport_result.custom_data);
                const log_string = `approved & processed (${custom_data.merchant_uid})`;
                // Insert payment result to db
                mongoDB.getDB().collection('payment-transactions').insertOne({
                    business_id: custom_data.business_id,
                    imp_uid: iamport_result.imp_uid,
                    merchant_uid: custom_data.merchant_uid,
                    type: custom_data.type,
                    name: custom_data.name,
                    currency: iamport_result.currency,
                    amount: custom_data.amount,
                    vat: custom_data.vat,
                    customer_uid: custom_data.customer_uid,
                    pay_method: iamport_result.pay_method,
                    card_name: iamport_result.card_name,
                    status: status,
                    receipt_url: iamport_result.receipt_url,
                    pay_date: custom_data.pay_date,
                    time_paid: moment(iamport_result.paid_at * 1000).toDate(),
                })
                    .then((tx_insert_result) => {
                        if (custom_data.type === payment_type.scheduled) {
                            // If payment was a scheduled payment, update the scheduled payments status to PAID
                            mongoDB.getDB().collection('payment-schedule').updateOne(
                                { merchant_uid: custom_data.merchant_uid },
                                { $set: { status: status } },
                                (schedule_update_error, write_result) => {
                                    if (schedule_update_error) { logger.error(schedule_update_error); }
                                    logger.debug(`Scheduled payment ${log_string}`);
                                }
                            );
                        } else if (custom_data.type === payment_type.initial) {
                            logger.debug(`Initial payment ${log_string}`);
                            // TODO: Enable Castr service
                            logger.debug(`Enabling Castr service for business (${custom_data.business_id})`);
                        }
                    })
                    .then(() => {
                        // Calculate next pay date
                        const next_pay_date = moment(custom_data.pay_date).tz(timezone.seoul)
                            .add(billing_plan_type[custom_data.billing_plan], 'week')
                            .hour(0)
                            .minute(0)
                            .second(0)
                            .millisecond(0);
                        // Insert to payment-schedule collection
                        const next_charge_num = parseInt(custom_data.merchant_uid.match(/\d+$/)[0]) + 1;
                        const next_merchant_uid = `${custom_data.business_id}_ch${next_charge_num}`;
                        mongoDB.getDB().collection('payment-schedule').insertOne(
                            {
                                merchant_uid: next_merchant_uid,
                                business_id: custom_data.business_id,
                                schedule: next_pay_date.toDate(),
                                amount: custom_data.amount,
                                vat: custom_data.vat,
                                billing_plan: custom_data.billing_plan,
                                status: status_type.pending,
                            },
                            (db_error) => {
                                if (db_error) { logger.error(db_error); }
                                logger.debug(`Next payment (${next_merchant_uid}) scheduled for ${next_pay_date.format('LL')}`);
                            }
                        );
                    })
                    .catch((error) => { logger.error(error); });
                break;
            }
            case status_type.cancelled: {
                // TODO: Update database as refunded
                break;
            }
            case status_type.failed: {
                const custom_data = JSON.parse(iamport_result.custom_data);
                // If payment was a scheduled payment, update the scheduled payments status to FAILED
                if (custom_data.type === payment_type.scheduled) {
                    const failure = {
                        imp_uid: iamport_result.imp_uid,
                        params: custom_data,
                        reason: iamport_result.fail_reason,
                        time_failed: moment(iamport_result.failed_at * 1000).toDate(),
                    };
                    mongoDB.getDB().collection('payment-schedule').updateOne(
                        { merchant_uid: custom_data.merchant_uid },
                        {
                            $set: { status: status },
                            $push: {
                                failures: {
                                    $each: [failure],
                                    $sort: { time_failed: -1 },
                                },
                            },
                        }
                    )
                        .then((write_result) => {
                            logger.debug(`Scheduled payment (${custom_data.merchant_uid}) rejected`);
                            // TODO: Disable castr service until failed payment is resolved (Set a different payment method to resolve failed payment)
                            logger.debug(`Disabling Castr service for business (${custom_data.business_id})`);
                        })
                        .catch((db_error) => {
                            logger.error(db_error);
                        });
                }
                break;
            }
            default: {
                logger.debug(`Default block reached with:\n${iamport_result}`);
            }
        }
    }

    /**
     * Generates a name for the payment.
     * @param {*} params 
     */
    _generateName(params) {
        const business_id = params.business_id;
        if (params.type === payment_type.menucast) {
            const promotable_id = params.promotable_id;
            return {
                short: `MC#${business_id}=${promotable_id}`,
                long: `Menucast purchase [#${business_id}] - ${promotable_id}`,
                long_kr: `메뉴캐스트 결제 [#${business_id}] - ${promotable_id}`,
            };
        }
        const billing_plan = params.billing_plan;
        const pay_date = params.pay_date;
        const start = moment(pay_date).tz(timezone.seoul);
        const end = moment(start).add(billing_plan_type[billing_plan], 'week').subtract(1, 'day');
        return {
            short: `CAS#${business_id}=${start.format('M/D')}-${end.format('M/D')}(${billing_plan_type[billing_plan]}WK)`,
            long: `Castr subscription #${business_id} ${start.format('M/D')}-${end.format('M/D')} (${billing_plan})`,
            long_kr: `캐스터 정기구독 #${business_id} ${start.format('M/D')}-${end.format('M/D')} (${billing_plan_type[billing_plan]}주)`,
        };
    }
}

module.exports = new IamportService();
