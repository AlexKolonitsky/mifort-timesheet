/*!
 * Copyright 2015 mifort.org
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * @author Andrew Voitov
 */

var moment = require('moment');

var db = require('./libs/mongodb_settings');
var users = require('./user');
var utils = require('./libs/utils');
var registration = require('./libs/registration');
var log = require('./libs/logger');
var authorization = require('./libs/authorization');
var mail = require('./libs/mail');

//Rest API
exports.restFindById = function(req, res, next) {
    var companyId = utils.getCompanyId(req);
    log.debug('-REST call: Find company by id. Company id: %s', companyId.toHexString());

    findById(companyId, function(err, company, next) {
        if(err) {
            err.code = 400;
            next(err);
        } else {
            res.json(company);
            log.debug('-REST result: Finded company id. Company id: %s',
                company._id.toHexString());
        }
    });
};

exports.restCreateCompany = function(req, res, next) {
    var company = req.body;
    log.debug('-REST call: Create company. Company name: %s', company.name);

    var defaultCompany = exports.generateDefaultCompany();
    company.template = defaultCompany.template;
    company.periods = defaultCompany.periods;
    company.dayTypes = defaultCompany.dayTypes;
    company.defaultValues = defaultCompany.defaultValues;
    company.availablePositions = defaultCompany.availablePositions;
    if(req.user) {
        company.ownerId = req.user._id;
    }

    save(company, function(err, savedCompany) {
        if(err) {
            next(err);
        } else {
            //Warning: asynchronous operations!!!
            registration.createDefaultProject(savedCompany, req.user);
            createUsersByEmails(savedCompany);
            res.json(savedCompany);
            log.debug('-REST result: Create company. Company id: %s',
                savedCompany._id.toHexString());
        }
    });
};

exports.restUpdateCompany = function(req, res, next) {
    var company = req.body;
    log.debug('-REST call: Update company. Company id: %s', company._id.toHexString());
    save(company, function(err, savedCompany) {
        if(err) {
            next(err);
        } else {
            //update all projects
            var projects = db.projectCollection();
            projects.update(
                    {companyId: savedCompany._id},
                    {$set: {template: savedCompany.template,
                            periods: savedCompany.periods,
                            defaultValues: savedCompany.defaultValues,
                            dayTypes: savedCompany.dayTypes,
                            availablePositions: savedCompany.availablePositions}},
                    {multi: true},
                function(err, result){
                    log.info('Company projects are updated!')
                });
            createUsersByEmails(savedCompany);
            res.json(savedCompany);
            log.debug('-REST result: Update company. Company id: %s',
                savedCompany._id.toHexString());
        }
    });
};

//Public API
exports.save = save;

//Default roles
var defaultAvailablePositions = [
    'СEO',
    'CTO',
    'Designer',
    'Developer',
    'Junior Developer',
    'Junior QA',
    'Manager',
    'QA',
    'Senior Developer',
    'Senior QA',
    'Teamlead',
    'UX'
];

//dayTypes
var Weekend = {
    id: 1,
    name: 'Weekend',
    time: 0,
    color: '#c5e9fb'
};
var Corporate = {
    id: 2,
    name: 'Corporate',
    time: 0,
    color: '#f3cce1'
};
var Holiday = {
    id: 3,
    name: 'Holiday',
    time: 0,
    color: '#fff9a1'
};

exports.generateDefaultCompany = function() {
    var periods = generateDefaultPeriods();
    var defaultValues = generateDefaultValues(periods);

    var company = constructCompany(periods, defaultValues);
    return company;
};

exports.findById = findById;

//private part
function findById(id, callback) {
    var companies = db.companyCollection();
    companies.findOne({_id: id}, function(err, company){
        callback(err, company);
    });
}

function createUsersByEmails(company) {
    var emails = company.emails;
    if(emails) {
        emails.forEach(function(email) {
            var user = {email: email,
                        companyId: company._id};

            users.findByExample(user, function(err, dbUser) {
                if(err) {
                    log.warn('Cannot find user by email for new company.', {error: err});
                } else if(!dbUser) {
                    user.displayName = email;
                    user.role = authorization.EMPLOYEE_ROLE;
                    users.save(user, function(err, savedUser) {
                        if(err) {
                            log.error('Cannot save user by email for new company.', {error: err});
                        } else {
                            log.info('User saved with e-mail %s', savedUser.email);
                            mail.sendInvite(email);
                        }
                    });
                }
            });

        })
    }
}

function save(company, callback) {
    var companies = db.companyCollection();
    companies.save(company, {safe:true}, function (err, result) {
        if(result.ops) {
            callback(err, result.ops[0]);
        } else {
            callback(err, company);
        }
    });
}

function constructCompany(periods, defaultValues) {
    return {
        template : {
            date: '',
            role: '',
            time: 8,
            comment: ''
        },
        periods: periods,
        dayTypes: [
            Weekend, Corporate, Holiday
        ],
        defaultValues: defaultValues,
        availablePositions: defaultAvailablePositions
    };
}

function generateDefaultPeriods() {
    var periods = [];

    var firstPeriod = {
        start: moment.utc().toDate(),
        end: moment.utc().endOf('week').toDate()
    };
    periods.push(firstPeriod);

    //generate 53 weeks (1 year)
    var startDate = moment.utc(firstPeriod.end).add(1,'day').toDate();
    var endDate = moment.utc(startDate).endOf('week').toDate();
    for (var i = 0; i < 53; i++) {
        periods.push({
            start: startDate,
            end: endDate
        });
        startDate = moment.utc(endDate).add(1,'day').toDate();
        endDate = moment.utc(startDate).endOf('week').toDate();
    };

    return periods;
}

function generateDefaultValues(periods) {
    var defaultValues = [];

    periods.forEach(function(period) {
        if(isWeekend(period.start)) {
            defaultValues.push({date: period.start, dayId: Weekend.id});
        }
        if(isWeekend(period.end)) {
            defaultValues.push({date: period.end, dayId: Weekend.id});
        }
    });

    return defaultValues;
}

function isWeekend(date) {
    return moment.utc(date).day() % 6 == 0;
}
