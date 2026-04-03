// server/routes/enroll.routes.js

const express = require("express");
const router  = express.Router();
const { enrollCourse, getMyCourses } = require("../controllers/enroll.controller");
const { protect, restrictTo }        = require("../middleware/auth.middleware");
const User = require("../models/User.model");

// ── POST /api/enroll  (original route) ───────────────────────────────────────
router.post("/enroll", protect, restrictTo("student"), enrollCourse);

// ── POST /api/enrollments/:courseId  (used by Shopify.jsx detail page) ────────
router.post("/enrollments/:courseId", protect, restrictTo("student"), (req, res) => {
  req.body.courseId = req.params.courseId;
  return enrollCourse(req, res);
});

// ── GET /api/enrollments/check/:courseId  (used by Shopify.jsx) ───────────────
router.get("/enrollments/check/:courseId", protect, async (req, res) => {
  try {
    const student    = await User.findById(req.user._id);
    const isEnrolled = student.enrolledCourses
      .map(id => id.toString())
      .includes(req.params.courseId);
    res.json({ isEnrolled, enrolled: isEnrolled });
  } catch {
    res.json({ isEnrolled: false, enrolled: false });
  }
});

// ── GET /api/my-courses ───────────────────────────────────────────────────────
router.get("/my-courses", protect, restrictTo("student"), getMyCourses);

module.exports = router;