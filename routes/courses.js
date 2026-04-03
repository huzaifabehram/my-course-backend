```js
const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/authMiddleware");
const {
  getCourse, getCourseReviews, getSimilarCourses, addReview, enrollInCourse,
} = require("../controllers/courseController");

router.get("/:id", getCourse);
router.get("/:id/reviews", getCourseReviews);
router.get("/:id/similar", getSimilarCourses);
router.post("/:id/reviews", protect, addReview);
router.post("/:id/enroll", protect, enrollInCourse);

module.exports = router;
```

