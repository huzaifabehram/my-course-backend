const Progress = require('../models/Progress');
const Course = require('../models/Course');

// @desc    Get student's progress in a course
// @route   GET /api/progress/:courseId
// @access  Private
const getProgress = async (req, res) => {
  try {
    let progress = await Progress.findOne({
      student: req.user._id,
      course: req.params.courseId,
    });

    if (!progress) {
      return res.json({ completedLectures: [], lastWatchedLecture: null, percentage: 0 });
    }

    // Calculate total lectures in course
    const course = await Course.findById(req.params.courseId);
    const totalLectures = course.sections.reduce(
      (sum, section) => sum + section.lectures.length,
      0
    );

    const percentage =
      totalLectures > 0
        ? Math.round((progress.completedLectures.length / totalLectures) * 100)
        : 0;

    res.json({
      completedLectures: progress.completedLectures,
      lastWatchedLecture: progress.lastWatchedLecture,
      percentage,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Mark a lecture as completed / incomplete
// @route   POST /api/progress/:courseId/lecture/:lectureId
// @access  Private
const toggleLectureComplete = async (req, res) => {
  try {
    const { courseId, lectureId } = req.params;

    let progress = await Progress.findOne({
      student: req.user._id,
      course: courseId,
    });

    if (!progress) {
      progress = await Progress.create({
        student: req.user._id,
        course: courseId,
        completedLectures: [],
      });
    }

    const alreadyCompleted = progress.completedLectures.includes(lectureId);

    if (alreadyCompleted) {
      // Remove from completed (unmark)
      progress.completedLectures = progress.completedLectures.filter(
        (id) => id.toString() !== lectureId
      );
    } else {
      // Add to completed
      progress.completedLectures.push(lectureId);
    }

    progress.lastWatchedLecture = lectureId;
    await progress.save();

    // Recalculate percentage
    const course = await Course.findById(courseId);
    const totalLectures = course.sections.reduce(
      (sum, section) => sum + section.lectures.length,
      0
    );
    const percentage =
      totalLectures > 0
        ? Math.round((progress.completedLectures.length / totalLectures) * 100)
        : 0;

    res.json({
      completedLectures: progress.completedLectures,
      percentage,
      message: alreadyCompleted ? 'Lecture unmarked' : 'Lecture marked as complete!',
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = { getProgress, toggleLectureComplete };
