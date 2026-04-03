``
const express = require("express");
const router = express.Router();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { protect } = require("../middleware/authMiddleware");

// POST /api/payments/checkout
router.post("/checkout", protect, async (req, res) => {
  const { courseId, courseTitle, price } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: courseTitle },
          unit_amount: Math.round(price * 100),
        },
        quantity: 1,
      }],
      mode: "payment",
      success_url: `${process.env.CLIENT_URL}/success?courseId=${courseId}`,
      cancel_url: `${process.env.CLIENT_URL}/course/${courseId}`,
      metadata: { courseId, userId: req.user._id.toString() },
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ message: "Payment error", error: err.message });
  }
});

module.exports = router;
``
