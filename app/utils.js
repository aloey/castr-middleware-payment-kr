// app/utils.js

'use strict';

const logger = require('tracer').console({
    format: "[{{timestamp}}] <{{title}}> {{message}} - ({{file}}:{{line}})",
    dateformat: "mmm. d | HH:MM:ss.L"
});

const moment = require('moment-timezone');
moment.locale('kr', {
    "months": ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'],
    // "monthsShort": RESERVED FOR ENGLISH ABBREVIATED MONTHS
    "weekdays": ['월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일'],
    // "weekdaysShort": RESERVED FOR ENGLISH ABBREVIATED WEEKDAYS
    "weekdaysMin": ['월', '화', '수', '목', '금', '토', '일'],
    "longDateFormat": {
        LT: "A h:mm",
        LTS: "A h:mm:ss",
        L: "YYYY/MM/DD",
        LL: "YYYY년 M월 D일",
        LLL: "YYYY년 M월 D일 LT",
        LLLL: "YYYY년 M월 D일 dddd LT"
    },
    "meridiem": function (hour, minute, isLowercase) {
        if (hour < 12) {
            return "오전";
        } else {
            return "오후";
        }
    }
})

module.exports = {
    "logger": function () {
        return logger;
    },
    "moment": function () {
        return moment;
    }
}