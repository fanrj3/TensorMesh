# TensorMesh MNIST Example

This example trains a small CNN on MNIST and writes outputs under `example/runs/mnist`.

## Run locally

```bash
python example/train_mnist.py --epochs 2
```

## Run with TensorMesh / Slurm

Use one GPU selected by Slurm:

```bash
cd <repo>
tmesh run --gpus 1 --name mnist-demo --time 0.5 -- python example/train_mnist.py --epochs 2
```

Use a specific GPU, for example GPU 4:

```bash
cd <repo>
tmesh run --gpu-indexes 4 --name mnist-gpu4 --time 0.5 -- python example/train_mnist.py --epochs 2
```

Watch the queue:

```bash
tmesh jobs --all
```

After the job starts, check its log from the repository root. Replace `<JOB_ID>` with the Slurm job id:

```bash
tail -f .tmesh/<JOB_ID>/run.log
```

Expected output includes:

```text
device=cuda
cuda_visible_devices=...
epoch=1 ...
saved_checkpoint=example/runs/mnist/mnist_cnn.pt
saved_metrics=example/runs/mnist/metrics.json
```

## Quick smoke test

After MNIST has been downloaded once, this checks the training loop with only a few batches:

```bash
cd <repo>
tmesh run --gpu-indexes 4 --name mnist-smoke --time 0.1 -- python example/train_mnist.py --epochs 1 --no-download --limit-train-batches 2 --limit-test-batches 2 --output-dir example/runs/smoke
```

## Notes

The system `/usr/bin/python3` does not include PyTorch, and the base conda PyTorch build may not match this machine's NVIDIA driver. Use an interpreter whose PyTorch build matches your NVIDIA driver (for example, the `python` from a conda environment created for your CUDA version).

The first run downloads MNIST. If this machine has no internet access, prepare the dataset on another machine and copy it to:

```text
example/data/MNIST/raw
```

Then run with `--no-download`.
