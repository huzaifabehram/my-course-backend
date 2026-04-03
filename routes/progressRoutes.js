const express = require('express');
const router = express.Router();
const { getProgress, toggleLectureComplete } = require('../controllers/progressController');
const { protect } = require('../middleware/authMiddleware');

router.get('/:courseId', protect, getProgress);
router.post('/:courseId/lecture/:lectureId', protect, toggleLectureComplete);

module.exports = router;
