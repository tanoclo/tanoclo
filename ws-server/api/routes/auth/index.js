'use strict';

const express = require('express');
const router = express.Router();

router.use(require('./oauth-flows'));
router.use(require('./tokens'));
router.use(require('./sessions'));

module.exports = router;
